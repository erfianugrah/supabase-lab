import { defineConfig } from "@playwright/test";

/**
 * End-to-end suite against the LIVE deployment. The demo is a static shell
 * plus a read RPC surface; the only honest end-to-end target is the deployed
 * worker talking to the live project. Base URL overridable for a preview
 * deploy: PGGRAPH_BASE_URL=https://... bunx playwright test
 *
 * Serial by politeness: the suite hammers a small shared demo project.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: process.env.PGGRAPH_BASE_URL ?? "https://pggraph.erfi.dev",
    actionTimeout: 15_000,
  },
});
