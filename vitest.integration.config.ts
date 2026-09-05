import { defineConfig } from "vitest/config";

// DB-backed integration tests — run against the TEST_DATABASE_URL Neon BRANCH, never
// the demo database. Branches are isolated schema+data copies, so these are safe to run
// even while a live demo is streaming against DATABASE_URL.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
