import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { config } from "../../src/config.js";
import { db } from "../../src/db/pool.js";
import { redis } from "../../src/redis.js";

// Ghost Agent integration: vault key auth, profiles, privacy rules, the mission chat loop with
// a scripted upstream (LLM + Tavily), the zero-trust permission flow, and the Ghost Receipt.

let app: FastifyInstance;
let fake: Server;
let vaultKey: string;
let testProductId: string;

interface ScriptedResponse {
  content: string | null;
  toolCalls?: ToolCallSpec[];
}

interface ToolCallSpec {
  id: string;
  name: string;
  arguments: string;
}

const scripts: ScriptedResponse[] = [];
const seenBodies: Record<string, unknown>[] = [];

const llmResponse = (r: ScriptedResponse) =>
  JSON.stringify({
    id: "ghost-gen-1",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.content,
          ...(r.toolCalls?.length
            ? {
                tool_calls: r.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

const toolCall = (id: string, name: string, args: Record<string, unknown>): ToolCallSpec => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const gh = (headers: Record<string, string> = {}) => ({ "x-ghost-key": vaultKey, ...headers });

beforeAll(async () => {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = path.resolve("migrations");
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(await readFile(path.join(dir, f), "utf8"));
  }
  await redis.flushdb();

  // a purchasable product for the Ghost Payment flow (supplier balance covers the cost)
  await db.query(
    `INSERT INTO suppliers (id, name, category, balance_usd) VALUES ('ghost-test', 'Ghost Test', 'ai_credits', 100)
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO products (supplier_id, supplier_sku, category, title, region, specs, cost_usd, price_usd, required_fields, active)
     VALUES ('ghost-test', 'test-5', 'ai_credits', 'Test AI credits $5', '', '{}', 4, 5, '[]', true)
     ON CONFLICT (supplier_id, supplier_sku) DO NOTHING`,
  );
  testProductId = (await db.query<{ id: string }>("SELECT id FROM products WHERE supplier_id = 'ghost-test' LIMIT 1")).rows[0]!.id;

  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:60001");
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seenBodies.push(JSON.parse(raw || "{}"));
        const scripted = scripts.shift();
        res.setHeader("content-type", "application/json");
        res.end(
          scripted
            ? llmResponse(scripted)
            : JSON.stringify({ choices: [{ message: { role: "assistant", content: "fallback reply" } }] }),
        );
      });
      return;
    }
    if (url.pathname === "/search" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            results: [
              {
                title: "Provider A",
                url: "https://a.example/plans",
                content: "VPS from $5/mo, signup needs only an email",
                score: 0.95,
              },
            ],
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => fake.listen(60001, "127.0.0.1", resolve));

  config.GHOST_LLM_API_KEY = "test-llm-key";
  config.GHOST_LLM_BASE_URL = "http://127.0.0.1:60001/v1";
  config.TAVILY_API_KEY = "test-tavily-key";
  config.TAVILY_BASE_URL = "http://127.0.0.1:60001";
  process.env.FEATURE_GHOST_AGENT = "1";

  app = buildServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  process.env.FEATURE_GHOST_AGENT = "";
  await app.close();
  await new Promise<void>((resolve) => {
    fake.close(() => resolve());
    fake.closeAllConnections?.();
  });
  await db.end();
  redis.disconnect();
});

describe("ghost agent gating and vault", () => {
  it("answers 'not enabled' while the feature is off", async () => {
    process.env.FEATURE_GHOST_AGENT = "";
    const res = await app.inject({ method: "POST", url: "/ghost/vault", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "ghost agent is not enabled" });
    process.env.FEATURE_GHOST_AGENT = "1";
  });

  it("creates a vault, returns the key once, and authenticates by it", async () => {
    const created = await app.inject({ method: "POST", url: "/ghost/vault", payload: {} });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.vault_key).toMatch(/^noma_gv_[A-Za-z0-9_-]{43}$/);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].email_alias).toMatch(/^ghost-[0-9a-f]{6}@noma\.alias$/);
    expect(body.rules).toMatchObject({ email: "alias", phone: "deny", wallet: "deny" });
    vaultKey = body.vault_key as string;

    const vault = await app.inject({ method: "GET", url: "/ghost/vault", headers: gh() });
    expect(vault.statusCode).toBe(200);
    expect(vault.json().key_last4).toBe(vaultKey.slice(-4));

    expect((await app.inject({ method: "GET", url: "/ghost/vault" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/ghost/vault", headers: { "x-ghost-key": "noma_gv_invalid" } })).statusCode,
    ).toBe(401);
  });

  it("manages profiles and privacy rules", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/ghost/profiles",
      headers: gh(),
      payload: { name: "Forum lurker" },
    });
    expect(created.statusCode).toBe(201);
    const profile = created.json();
    expect(profile.name).toBe("Forum lurker");
    expect(profile.aliases.phone).toMatch(/^noma-ghost-/);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/ghost/profiles/${profile.id}`,
      headers: gh(),
      payload: { name: "Newsletter reader" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Newsletter reader");

    const rules = await app.inject({
      method: "PUT",
      url: "/ghost/rules",
      headers: gh(),
      payload: { rules: { phone: "alias", wallet: "deny" } },
    });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().rules.phone).toBe("alias");

    const removed = await app.inject({ method: "DELETE", url: `/ghost/profiles/${profile.id}`, headers: gh() });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "PATCH", url: `/ghost/profiles/${profile.id}`, headers: gh(), payload: { name: "x" } })).statusCode).toBe(404);
  });
});

describe("ghost mission chat", () => {
  it("researches via tools, pauses for a denied field, then presents recommendations", async () => {
    await app.inject({ method: "PUT", url: "/ghost/rules", headers: gh(), payload: { rules: { phone: "deny" } } });
    scripts.push(
      {
        content: null,
        toolCalls: [toolCall("c1", "search_web", { query: "privacy vps under 10 usd no phone" })],
      },
      {
        content: null,
        toolCalls: [toolCall("c2", "request_identity", { field: "phone", reason: "one provider needs a phone for signup" })],
      },
    );
    const first = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "Find me a privacy-friendly VPS under $10/month without a phone number." },
    });
    expect(first.statusCode).toBe(200);
    const ask = first.json();
    expect(ask.permission_request).toMatchObject({
      field: "phone",
      reason: expect.any(String),
      has_alias: true,
    });
    expect(ask.mission_id).toBeTruthy();
    const missionId = ask.mission_id as string;

    // deny → the loop resumes and the model presents its findings
    scripts.push(
      {
        content: null,
        toolCalls: [
          toolCall("c3", "present_recommendations", {
            items: [
              {
                name: "Provider A",
                price_usd: 5,
                privacy_note: "email-only signup, crypto accepted",
                url: "https://a.example/plans",
                reason: "cheapest, least data asked",
              },
            ],
          }),
        ],
      },
      { content: "Provider A is the best privacy-first fit under $10.", toolCalls: [] },
    );
    const denied = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { mission_id: missionId, message: "Deny — find one that does not need it.", permission: { decision: "deny" } },
    });
    expect(denied.statusCode).toBe(200);
    const reply = denied.json();
    expect(reply.permission_request).toBeNull();
    expect(reply.recommendations).toHaveLength(1);
    expect(reply.recommendations[0]).toMatchObject({ name: "Provider A", price_usd: 5 });
    expect(reply.message).toContain("Provider A");

    // the receipt reflects the whole trail
    const receipt = await app.inject({ method: "GET", url: `/ghost/missions/${missionId}/receipt`, headers: gh() });
    expect(receipt.statusCode).toBe(200);
    const r = receipt.json();
    expect(r.actions.search).toBe(1);
    expect(r.actions.permission_ask).toBe(1);
    expect(r.actions.permission_deny).toBe(1);
    expect(r.permissions).toEqual([{ field: "phone", decision: "deny" }]);
    expect(r.info_shared).toEqual({ real: [], aliased: [] });
    expect(r.recommendations).toHaveLength(1);
    expect(r.sites_visited).toEqual([]); // search only — no page opened

    // messages persisted, missions listed
    const missions = await app.inject({ method: "GET", url: "/ghost/missions", headers: gh() });
    expect(missions.statusCode).toBe(200);
    expect(missions.json().missions.length).toBeGreaterThanOrEqual(1);
    const mission = await app.inject({ method: "GET", url: `/ghost/missions/${missionId}`, headers: gh() });
    expect(mission.statusCode).toBe(200);
    expect(mission.json().messages.map((m: { role: string }) => m.role)).toEqual(["user", "user", "assistant"]);
  });

  it("approves a real value once: it is logged, never stored, never shown to the model", async () => {
    // email is alias by default — deny it so the model must ask
    await app.inject({ method: "PUT", url: "/ghost/rules", headers: gh(), payload: { rules: { email: "deny" } } });
    scripts.push(
      {
        content: null,
        toolCalls: [toolCall("c1", "request_identity", { field: "email", reason: "signup needs a contact email" })],
      },
      { content: "Recorded. I will use your email for the signup step.", toolCalls: [] },
    );
    const first = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "Sign me up with my real email." },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().permission_request).toMatchObject({ field: "email" });
    const missionId = first.json().mission_id as string;

    const secret = "super-secret@example.com";
    const approved = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { mission_id: missionId, message: "I approve.", permission: { decision: "approve", value: secret } },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().permission_request).toBeNull();

    // the grant and the share are recorded — the value itself is nowhere in the database
    const receipt = await app.inject({ method: "GET", url: `/ghost/missions/${missionId}/receipt`, headers: gh() });
    const r = receipt.json();
    expect(r.permissions).toEqual([{ field: "email", decision: "approve" }]);
    expect(r.info_shared.real).toEqual(["email"]);

    const stored = (
      await db.query(
        `SELECT (SELECT coalesce(string_agg(content, ' '), '') FROM ghost_mission_messages WHERE mission_id = m.id)
                || ' ' || m.state::text || ' ' || coalesce((SELECT string_agg(detail::text, ' ') FROM ghost_mission_events WHERE mission_id = m.id), '') AS blob
         FROM ghost_missions m WHERE m.id = $1`,
        [missionId],
      )
    ).rows[0].blob as string;
    expect(stored).not.toContain(secret);

    // approving without a pending ask is rejected
    const orphan = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { mission_id: missionId, message: "again", permission: { decision: "deny" } },
    });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json()).toEqual({ error: "no permission request pending" });
  });

  it("shares the alias automatically when the rule allows it", async () => {
    await app.inject({ method: "PUT", url: "/ghost/rules", headers: gh(), payload: { rules: { email: "alias" } } });
    scripts.push(
      {
        content: null,
        toolCalls: [toolCall("c1", "request_identity", { field: "email", reason: "newsletter signup" })],
      },
      { content: "I used your synthetic email alias for the signup.", toolCalls: [] },
    );
    const res = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "What email would you use for a newsletter?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().permission_request).toBeNull();

    const missionId = res.json().mission_id as string;
    const receipt = await app.inject({ method: "GET", url: `/ghost/missions/${missionId}/receipt`, headers: gh() });
    const r = receipt.json();
    expect(r.actions.alias_used).toBe(1);
    expect(r.info_shared.aliased).toEqual([{ field: "email", value: expect.stringMatching(/^ghost-[0-9a-f]{6}@noma\.alias$/) }]);
    expect(r.info_shared.real).toEqual([]);
  });

  it("scopes missions to the vault", async () => {
    const other = await app.inject({ method: "POST", url: "/ghost/vault", payload: {} });
    const otherKey = other.json().vault_key as string;
    const missions = await app.inject({ method: "GET", url: "/ghost/missions", headers: gh({}) });
    const missionId = missions.json().missions[0].id as string;

    const stolen = await app.inject({
      method: "GET",
      url: `/ghost/missions/${missionId}/receipt`,
      headers: { "x-ghost-key": otherKey },
    });
    expect(stolen.statusCode).toBe(404);
  });
});

describe("ghost payment", () => {
  it("needs a budget, asks for confirmation, and never orders before the user confirms", async () => {
    const before = await app.inject({ method: "GET", url: "/ghost/vault", headers: gh() });
    expect(before.json().budget_usd).toBe(0);

    // budget 0 → purchase refused, no confirmation, no order
    scripts.push(
      {
        content: null,
        toolCalls: [toolCall("p1", "purchase_product", { product_id: testProductId, reason: "user asked", fields: {} })],
      },
      { content: "I cannot buy without a budget.", toolCalls: [] },
    );
    const refused = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "Buy me the test AI credits." },
    });
    expect(refused.statusCode).toBe(200);
    expect(refused.json().purchases).toEqual([]);
    expect(refused.json().purchase_request).toBeNull();
    const ordersAfterRefusal = (await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n as number;

    // set a budget, then the agent must ASK — no order yet (prompt-injection guard)
    const budget = await app.inject({
      method: "PUT",
      url: "/ghost/budget",
      headers: gh(),
      payload: { max_usd: 20 },
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json()).toMatchObject({ budget_usd: 20, remaining_usd: 20 });

    scripts.push(
      {
        content: null,
        toolCalls: [toolCall("p2", "search_catalog", { category: "ai_credits" })],
      },
      {
        content: null,
        toolCalls: [toolCall("p3", "purchase_product", { product_id: testProductId, reason: "user asked", fields: {} })],
      },
    );
    const asked = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "Buy me the test AI credits." },
    });
    expect(asked.statusCode).toBe(200);
    const ask = asked.json();
    expect(ask.purchases).toEqual([]);
    expect(ask.purchase_request).toMatchObject({
      product_id: testProductId,
      title: "Test AI credits $5",
      price_usd: 5,
      reason: "user asked",
    });
    expect((await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(ordersAfterRefusal);

    // confirming creates exactly one order and records the purchase
    scripts.push({ content: "Order created — pay it from your wallet.", toolCalls: [] });
    const confirmed = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: {
        mission_id: ask.mission_id,
        message: "Confirm the purchase.",
        purchase: { decision: "approve" },
      },
    });
    expect(confirmed.statusCode).toBe(200);
    const reply = confirmed.json();
    expect(reply.purchases).toHaveLength(1);
    expect(reply.purchases[0]).toMatchObject({
      product_id: testProductId,
      title: "Test AI credits $5",
      price_usd: 5,
      asset: "USDG",
      order_id: expect.any(String),
      order_key: expect.any(String),
    });
    expect((await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(ordersAfterRefusal + 1);
    expect((await db.query("SELECT count(*)::int AS n FROM ghost_purchases")).rows[0].n).toBe(1);

    const vault = await app.inject({ method: "GET", url: "/ghost/vault", headers: gh() });
    expect(vault.json()).toMatchObject({ budget_usd: 20, remaining_usd: 15 });

    const receipt = await app.inject({
      method: "GET",
      url: `/ghost/missions/${reply.mission_id}/receipt`,
      headers: gh(),
    });
    expect(receipt.json().purchases).toEqual([
      { order_id: reply.purchases[0].order_id, title: "Test AI credits $5", price_usd: 5 },
    ]);
  });

  it("cancels a stale purchase request when the user moves on", async () => {
    const ordersBefore = (await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n as number;
    scripts.push(
      { content: null, toolCalls: [toolCall("p5", "purchase_product", { product_id: testProductId, reason: "maybe", fields: {} })] },
    );
    const asked = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "Buy it." },
    });
    expect(asked.json().purchase_request).not.toBeNull();
    const missionId = asked.json().mission_id as string;

    // a new message without a decision drops the pending request; nothing is ordered
    scripts.push({ content: "Okay, cancelled.", toolCalls: [] });
    const movedOn = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { mission_id: missionId, message: "Never mind, let's do something else." },
    });
    expect(movedOn.statusCode).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(ordersBefore);
    const receipt = await app.inject({ method: "GET", url: `/ghost/missions/${missionId}/receipt`, headers: gh() });
    expect(receipt.json().actions.purchase_request).toBe(1);
    expect(receipt.json().actions.purchase_cancel).toBe(1);
  });

  it("refuses a purchase that would exceed the remaining budget", async () => {
    await app.inject({ method: "PUT", url: "/ghost/budget", headers: gh(), payload: { max_usd: 4 } });
    const ordersBefore = (await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n as number;

    scripts.push(
      {
        content: null,
        toolCalls: [toolCall("p4", "purchase_product", { product_id: testProductId, reason: "over budget", fields: {} })],
      },
      { content: "That exceeds the budget.", toolCalls: [] },
    );
    const res = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "Buy it anyway." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().purchases).toEqual([]);
    expect(res.json().purchase_request).toBeNull();
    expect((await db.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(ordersBefore);
  });
});

describe("mission management", () => {
  it("deletes a mission with its trail, scoped to the vault", async () => {
    scripts.push({ content: "quick mission done.", toolCalls: [] });
    const created = await app.inject({
      method: "POST",
      url: "/ghost/chat",
      headers: gh(),
      payload: { message: "quick mission" },
    });
    const id = created.json().mission_id as string;

    // another vault cannot delete it
    const other = await app.inject({ method: "POST", url: "/ghost/vault", payload: {} });
    const otherKey = other.json().vault_key as string;
    const stolen = await app.inject({
      method: "DELETE",
      url: `/ghost/missions/${id}`,
      headers: { "x-ghost-key": otherKey },
    });
    expect(stolen.statusCode).toBe(404);

    const del = await app.inject({ method: "DELETE", url: `/ghost/missions/${id}`, headers: gh() });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: "GET", url: "/ghost/missions", headers: gh() });
    expect(list.json().missions.map((m: { id: string }) => m.id)).not.toContain(id);
    expect((await app.inject({ method: "DELETE", url: `/ghost/missions/${id}`, headers: gh() })).statusCode).toBe(404);
  });

  it("keeps orders when their mission is deleted", async () => {
    // the purchase from the payment tests is still linked to its mission
    const missionRow = (await db.query("SELECT mission_id, order_id FROM ghost_purchases LIMIT 1")).rows[0];
    expect(missionRow).toBeTruthy();
    const del = await app.inject({ method: "DELETE", url: `/ghost/missions/${missionRow.mission_id}`, headers: gh() });
    expect(del.statusCode).toBe(204);
    expect((await db.query("SELECT 1 FROM orders WHERE id = $1", [missionRow.order_id])).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM ghost_purchases WHERE mission_id = $1", [missionRow.mission_id])).rowCount).toBe(0);
  });
});
