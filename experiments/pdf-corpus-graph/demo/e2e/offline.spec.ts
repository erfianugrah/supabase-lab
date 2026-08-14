import { test, expect } from "@playwright/test";

// The failure UX: with the read RPC surface unreachable, the shell must render
// the explicit DIAGNOSTIC: DATA SOURCE UNAVAILABLE panel rather than a blank
// page. This is the only spec that stubs the network.
test("offline mode shows the data-source-unavailable panel", async ({ page }) => {
  await page.route("**/rest/**", (route) => route.abort());
  await page.goto("/");

  await expect(page.getByText(/DIAGNOSTIC: DATA SOURCE UNAVAILABLE/)).toBeVisible();
  await expect(page.getByText(/backing demo database is currently offline/)).toBeVisible();
});
