import { test, expect } from "@playwright/test";

// Cross-document entities is the discovery entry point. The top bridge is a
// councillor, so its kind badge reads PERSON. The per-row details expander
// lists the documents that span. And the as-at date input is the temporal
// proof: 2020-01-01 predates all but one corpus document, so nothing can
// bridge and the table empties; clearing the input restores the all-time rows.
test("cross-document entities: person badge, document expander, and as-at filter", async ({ page }) => {
  await page.goto("/");

  const section = page.locator("section").filter({ hasText: "Cross-document entities" });
  await expect(section).toBeVisible();

  const rows = section.locator("tbody tr");
  const firstRow = rows.first();
  await expect(firstRow).toBeVisible();

  // The top bridge is a councillor: the kind cell carries a PERSON badge.
  await expect(firstRow.locator("td").first()).toContainText("PERSON");

  // The per-row "N documents" expander opens and names real doc slugs.
  const summary = firstRow.locator("details summary");
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(firstRow.locator("details[open]")).toContainText("inv-minutes-");

  // As-at: only one corpus document predates 2020-01-01, so no entity bridges
  // and the bridging table is empty. `bridgesAsAt` starts empty in the
  // component, so a bare row count would pass against the transient pre-fetch
  // state even if the RPC ignored the date and returned every bridge. Wait for
  // the bridges_as_at response, then assert the resolved note and empty table.
  const dateInput = section.locator("#as-at");
  await expect(section.locator('label[for="as-at"]')).toContainText("as at");
  await expect(dateInput).toBeVisible();
  const asAtResponse = page.waitForResponse((r) => r.url().includes("bridges_as_at"));
  await dateInput.fill("2020-01-01");
  await asAtResponse;
  await expect(section).toContainText("0 bridging entities as at 2020-01-01");
  await expect(rows).toHaveCount(0);

  // Clear restores the all-time bridging table.
  await section.getByRole("button", { name: "CLEAR" }).click();
  await expect(rows.first()).toBeVisible();
});
