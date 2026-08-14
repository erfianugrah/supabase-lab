import { test, expect } from "@playwright/test";

// Smoke probe: the shell renders and the stats strip carries live numbers.
test("landing renders the live corpus stats", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /public-record entity index/i }).first()).toBeVisible();
  // The strip is fed by demo.stats() over the wire - the values track the
  // committed corpus (au-corpus.json plus the US fixtures plus the scan
  // fixture), not a hardcoded string.
  await expect(page.locator("body")).toContainText("DOCUMENTS");
  await expect(page.locator("body")).toContainText("111");
  await expect(page.locator("body")).toContainText("PERSON");
});
