import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { HttpError } from "../../lib/errors.js";
import { redis } from "../../redis.js";
import { authenticate, balanceView, release, reserve, settle, usageHistory } from "../../modules/ai/service.js";
import {
  chatCompletion,
  generationCost,
  modelPricing,
  openRouterModels,
} from "../../modules/ai/openrouter.js";
import { aiMarkup, costFromUsage, estimatePromptTokens, reserveUsd } from "../../modules/ai/pricing.js";

const PER_KEY_PER_MINUTE = 60;

async function keyRateLimit(keyId: string): Promise<void> {
  const bucket = `ai:rate:${keyId}:${Math.floor(Date.now() / 60_000)}`;
  const count = await redis.incr(bucket);
  if (count === 1) await redis.expire(bucket, 120);
  if (count > PER_KEY_PER_MINUTE) throw new HttpError(429, "rate limit exceeded for this api key");
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function usageOf(value: unknown): Usage {
  return value && typeof value === "object" ? (value as Usage) : {};
}

export async function aiRoutes(app: FastifyInstance) {
  // OpenAI-compatible model list for the NOMA allowlist.
  app.get("/ai/v1/models", async (req) => {
    await authenticate(req.headers.authorization);
    let upstream: Awaited<ReturnType<typeof openRouterModels>> = [];
    try {
      upstream = await openRouterModels();
    } catch {
      // still answer with the configured allowlist; the actual call will fail loudly if upstream is down
    }
    return {
      object: "list",
      data: config.OPENROUTER_MODELS.map((id) => {
        const model = upstream.find((m) => m.id === id);
        return {
          id,
          object: "model",
          owned_by: "openrouter",
          name: model?.name ?? id,
          context_length: model?.context_length,
          pricing: model?.pricing,
        };
      }),
    };
  });

  app.get("/ai/v1/usage", async (req) => {
    const key = await authenticate(req.headers.authorization);
    return balanceView(key);
  });

  app.get("/ai/v1/usage/history", async (req) => {
    const key = await authenticate(req.headers.authorization);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    return { usage: await usageHistory(key.id, limit) };
  });

  app.post(
    "/ai/v1/chat/completions",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const key = await authenticate(req.headers.authorization);
      await keyRateLimit(key.id);

      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") throw new HttpError(400, "invalid request body");
      const model = typeof body.model === "string" ? body.model : "";
      if (!config.OPENROUTER_MODELS.includes(model)) {
        throw new HttpError(400, `model not allowed; use one of: ${config.OPENROUTER_MODELS.join(", ")}`);
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new HttpError(400, "messages must be a non-empty array");
      }

      const stream = body.stream === true;
      const maxField =
        typeof body.max_completion_tokens === "number" ? "max_completion_tokens" : "max_tokens";
      const requested =
        typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : typeof body.max_tokens === "number"
            ? body.max_tokens
            : 1024;
      const maxTokens = Math.max(1, Math.min(Math.floor(requested), config.AI_MAX_TOKENS));

      const promptTokens = estimatePromptTokens(body.messages, body.tools);
      const price = await modelPricing(model);
      const markup = await aiMarkup();
      const estimate = reserveUsd(
        promptTokens,
        maxTokens,
        price.prompt,
        price.completion,
        markup,
        config.AI_RESERVE_SAFETY,
      );

      const { usageId } = await reserve(key, model, estimate);
      const upstreamBody = { ...body, model, [maxField]: maxTokens, stream };

      let upstream: Response;
      try {
        upstream = await chatCompletion(upstreamBody, stream);
      } catch (err) {
        await release(usageId, `upstream unavailable: ${String(err)}`);
        throw new HttpError(502, "AI upstream unavailable");
      }
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        await release(usageId, `upstream ${upstream.status}: ${text.slice(0, 200)}`);
        throw new HttpError(502, `AI upstream error (${upstream.status})`);
      }

      if (!stream) {
        const data = (await upstream.json()) as Record<string, unknown>;
        const usage = usageOf(data.usage);
        const generationId = typeof data.id === "string" ? data.id : null;
        const cost =
          (await generationCost(generationId)) ?? costFromUsage(usage, price.prompt, price.completion);
        await settle(usageId, cost, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, generationId);
        return data;
      }

      if (!upstream.body) {
        await release(usageId, "upstream returned no stream");
        throw new HttpError(502, "AI upstream returned no stream");
      }

      reply.hijack();
      const origin = req.headers.origin;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let generationId: string | null = null;
      let usage: Usage | null = null;
      let closed = false;
      reply.raw.on("close", () => {
        closed = true;
      });

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              try {
                const parsed = JSON.parse(raw) as { id?: unknown; usage?: unknown };
                if (typeof parsed.id === "string") generationId = parsed.id;
                if (parsed.usage) usage = usageOf(parsed.usage);
              } catch {
                // ignore malformed keepalive frames
              }
            }
          }
          if (!closed) reply.raw.write(value);
        }
        if (!closed) reply.raw.end();
      } catch (err) {
        if (!closed) reply.raw.end();
        await release(usageId, `stream failed: ${String(err)}`).catch(() => undefined);
        return;
      }

      const cost =
        (await generationCost(generationId)) ??
        costFromUsage(usage, price.prompt, price.completion);
      await settle(usageId, cost, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, generationId);
    },
  );
}
