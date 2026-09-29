import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const received: { kind: string; message: string; text: string; details: Record<string, unknown> }[] = [];
let status = 200;
let server: Server;
let mod: typeof import("../../src/lib/alerts.js") & typeof import("../../src/redis.js");

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // config is parsed on first import, so the webhook must be in the env before that
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  mod = { ...(await import("../../src/lib/alerts.js")), ...(await import("../../src/redis.js")) };
  await mod.redis.del("alert:test-a", "alert:test-b", "alert:test-fail");
});

afterAll(async () => {
  server.close();
  mod.redis.disconnect();
});

describe("alert delivery", () => {
  it("delivers to the webhook once per key within the cooldown", async () => {
    await mod.alert("supplier balance low", { supplier: "bitrefill", balance_usd: 3, big: { v: 10n ** 30n } }, { key: "test-a" });
    await mod.alert("supplier balance low", { supplier: "bitrefill" }, { key: "test-a" });
    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe("alert");
    expect(received[0]!.details.supplier).toBe("bitrefill");
    expect(received[0]!.text).toContain("ALERT: supplier balance low");
    expect(received[0]!.text).toContain(`big: {"v":"${(10n ** 30n).toString()}"}`);

    await mod.alert("Safe owners: sign", { cycleId: 1 }, { kind: "action", key: "test-b" });
    expect(received).toHaveLength(2);
    expect(received[1]!.text).toContain("ACTION: Safe owners: sign");
  });

  it("never throws when delivery fails", async () => {
    status = 500;
    await expect(mod.alert("boom", {}, { key: "test-fail" })).resolves.toBeUndefined();
    expect(received).toHaveLength(3);
    status = 200;
  });
});
