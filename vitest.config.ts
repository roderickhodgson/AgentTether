import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The fast suite only: pure units + mocked HTTP/orchestration tests, colocated.
    // Money-moving and live-chain verification stays in spikes/ (see verify:live),
    // and DB-backed tests run via `npm run test:integration` against the Neon branch.
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts", "**/node_modules/**"],
  },
});
