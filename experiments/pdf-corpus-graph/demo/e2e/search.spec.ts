import { test, expect } from "@playwright/test";

// Two closed loops: the entity search pins the White Rock Wind Farm org to its
// checksum-validated ABN, and the document search surfaces the source text.
test("entity search pins the org ABN and document search surfaces the source", async ({ page }) => {
  await page.goto("/");

  // Hydration gate: the stats strip populates only after the client island
  // mounts and its first fetch resolves, so this waits out the SSR shell.
  await expect(page.locator("body")).toContainText("DOCUMENTS");

  const entityInput = page.locator('input[aria-label="search entities"]');
  await expect(entityInput).toBeVisible();

  const resultsTable = page.locator("section").filter({ hasText: "Entity search" });
  // The mount search (default "AC-1") must settle before a second search, or
  // its late response would overwrite ours.
  await expect(resultsTable.locator("tbody tr").first()).toContainText("AC-1");

  // Entity search: White Rock Wind Farm -> OPEN the org row -> the Registry
  // identifiers section shows the ABN, checksum-pinned at extraction.
  await entityInput.fill("White Rock Wind Farm");
  await entityInput.press("Enter");
  await expect(resultsTable.locator("tbody tr").first()).toContainText("White Rock Wind Farm");
  await resultsTable.getByRole("button", { name: "OPEN" }).first().click();

  const registrySection = page.locator("section").filter({ hasText: "Registry identifiers" });
  await expect(registrySection).toContainText("45 153 592 173");

  // Document search: the strongest hit's snippet names White Rock.
  const docInput = page.locator('input[aria-label="search document text"]');
  await expect(docInput).toBeVisible();
  await docInput.fill("White Rock");
  await docInput.press("Enter");

  const docTable = page.locator("section").filter({ hasText: "Document search" });
  await expect(docTable.locator("tbody tr").first()).toContainText(/white rock/i);
});
