import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://noma:noma@127.0.0.1:55442/noma_test",
      REDIS_URL: "redis://127.0.0.1:56389",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
    },
  },
});
