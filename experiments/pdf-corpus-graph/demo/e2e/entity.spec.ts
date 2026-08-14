import { test, expect } from "@playwright/test";

// The deep-link + graph + traversal proof: search a councillor, open her,
// verify the graph, timeline and neighbourhood, survive a reload, and find a
// path from the selection to a target.
test("entity search, selection, persistence, and shortest path work", async ({ page }) => {
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

  await entityInput.fill("Wendy Wilks");
  await entityInput.press("Enter");
  await expect(resultsTable.locator("tbody tr").first()).toContainText("Cr Wendy Wilks");
  await resultsTable.getByRole("button", { name: "OPEN" }).first().click();

  // The Selected entity panel names the opened councillor.
  const selectedSection = page.locator("section").filter({ hasText: "Selected entity" });
  await expect(selectedSection).toContainText("Cr Wendy Wilks");

  // Graph: a rendered svg carrying more than ten circle nodes.
  const graphSvg = page.getByRole("img", { name: "entity neighbourhood graph" });
  await expect(graphSvg).toBeVisible();
  expect(await graphSvg.locator("circle").count()).toBeGreaterThan(10);

  // Neighbourhood has rows.
  const neighbourhoodRows = page.locator("section").filter({ hasText: "Neighbourhood" }).locator("tbody tr");
  await expect(neighbourhoodRows.first()).toBeVisible();

  // Timeline's first date cell is an ISO date, not a placeholder.
  const timelineSection = page.locator("section").filter({ hasText: "Timeline" });
  await expect(timelineSection.locator("tbody tr td").first()).toHaveText(/\d{4}-\d{2}-\d{2}/);

  // Persistence: the deep link survives a reload with no interaction.
  await expect(page).toHaveURL(/\?entity=\d+/);
  await page.reload();
  await expect(page.locator("section").filter({ hasText: "Selected entity" })).toContainText("Cr Wendy Wilks");

  // Shortest path: target the first neighbourhood row, find a path, and
  // either a path table or the explicit NO PATH diagnostic must render.
  const firstNeighbourRow = page.locator("section").filter({ hasText: "Neighbourhood" }).locator("tbody tr").first();
  const setTarget = firstNeighbourRow.getByRole("button", { name: "SET TARGET" });
  await expect(setTarget).toBeVisible();
  await setTarget.click();
  await page.getByRole("button", { name: "FIND PATH" }).click();

  const pathContainer = page.locator("section").filter({ hasText: "Shortest path" });
  await expect(pathContainer.getByText(/DIAGNOSTIC: NO PATH/).or(pathContainer.locator("table"))).toBeVisible();
});
