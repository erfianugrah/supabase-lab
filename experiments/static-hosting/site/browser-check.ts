/**
 * Load one deployed copy of the site in headless Chromium and report what a
 * visitor gets, as one JSON line on stdout. Run as a subprocess by HS05 (the
 * compiled pvlab binary cannot bundle Playwright):
 *
 *   bun site/browser-check.ts <url> <screenshot.png>
 *
 * "Rendered" is judged from the DOM, not the headers: a page served as
 * text/plain becomes a <pre> holding the source, so the #h1 element does not
 * exist and the island marker never appears.
 */
import { chromium } from "playwright";

const [url, shot] = process.argv.slice(2);
if (!url) {
  console.error("usage: bun browser-check.ts <url> [screenshot.png]");
  process.exit(2);
}

// PVLAB_RESOLVE="host=ip" pins one name, so a fresh custom hostname is judged
// on the address a public resolver returns rather than on whether the local
// resolver has caught up.
const pin = process.env.PVLAB_RESOLVE?.split("=");
const browser = await chromium.launch(pin?.length === 2 ? { args: [`--host-resolver-rules=MAP ${pin[0]} ${pin[1]}`] } : {});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
  page.on("requestfailed", (r) => failed.push(`${r.url().split("/").pop()}: ${r.failure()?.errorText ?? "?"}`));
  page.on("response", (r) => r.status() >= 400 && failed.push(`${r.url().split("/").pop()}: HTTP ${r.status()}`));

  const nav = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch((e) => {
    failed.push(`navigation: ${String(e).slice(0, 160)}`);
    return null;
  });
  const docType = await page.evaluate(() => document.contentType).catch(() => "");
  const h1 = await page.locator("#h1").first().textContent({ timeout: 2_000 }).catch(() => null);
  const island = await page
    .locator("#island-state")
    .first()
    .textContent({ timeout: 5_000 })
    .catch(() => null);
  const api = await page.locator("#api-state").first().textContent({ timeout: 5_000 }).catch(() => null);
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily).catch(() => "");
  const fontLoaded = await page.evaluate(() => document.fonts.check('16px "IBM Plex Mono"')).catch(() => false);
  if (shot) await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);

  // Follow the nav link the way a visitor would.
  let about: { status: number; docType: string; h1: string | null; url: string } | null = null;
  if (h1 !== null && (await page.locator("#nav-about").count()) > 0) {
    const [resp] = await Promise.all([
      page.waitForNavigation({ timeout: 15_000 }).catch(() => null),
      page.click("#nav-about"),
    ]);
    about = {
      status: resp?.status() ?? 0,
      docType: await page.evaluate(() => document.contentType).catch(() => ""),
      h1: await page.locator("#h1").first().textContent({ timeout: 2_000 }).catch(() => null),
      url: page.url(),
    };
    if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-about.png") }).catch(() => undefined);
  }

  console.log(
    JSON.stringify({
      url,
      status: nav?.status() ?? 0,
      headerType: nav?.headers()["content-type"] ?? "",
      docType,
      rendered: h1 !== null,
      h1,
      island,
      hydrated: island === "hydrated",
      api,
      cssApplied: /IBM Plex Mono/.test(font),
      fontLoaded,
      consoleErrors,
      failed,
      about,
    }),
  );
} finally {
  await browser.close();
}
