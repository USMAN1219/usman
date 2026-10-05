import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    env: { APP_ENV: "test" },
    testTimeout: 20000,
  },
});
