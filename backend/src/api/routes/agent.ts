import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chat } from "../../modules/agent/service.js";

const body = z.object({
  session_id: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
});

export async function agentRoutes(app: FastifyInstance) {
  app.post("/agent/chat", async (req) => {
    const { session_id, message } = body.parse(req.body);
    return chat(session_id, message);
  });
}
