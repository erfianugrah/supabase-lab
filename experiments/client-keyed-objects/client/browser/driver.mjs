// Runs INSIDE the Playwright container (mcr.microsoft.com/playwright, whose
// browser build matches playwright-core in client/package.json). Serves the
// page and the bundle on http://localhost:4173, loads it in headless
// Chromium, runs window.ckRun(cfg) once per config, prints one JSON line.
//
//   docker run --rm -v <client>:/app:ro -v <workdir>:/work:ro <image> node /app/browser/driver.mjs
import { createServer } from "node:http";
import { connect, createServer as tcpServer } from "node:net";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const { forwards = [], targets: cfgs } = JSON.parse(readFileSync("/work/browser-cfg.json", "utf8"));
// localhost:<port> inside the container -> host.docker.internal:<port>, so the
// page uses the same URLs as every other client. A self-hosted Storage signs
// S3 requests against the host in STORAGE_PUBLIC_URL, so a rewritten host
// would fail SigV4 for a reason that belongs to the rig, not the platform.
for (const port of forwards) {
  tcpServer((c) => {
    const up = connect(port, "host.docker.internal");
    c.pipe(up).pipe(c);
    up.on("error", () => c.destroy());
    c.on("error", () => up.destroy());
  }).listen(port, "0.0.0.0");
}
const bundle = readFileSync("/work/bundle.js");
const html = `<!doctype html><meta charset="utf-8"><title>ck</title><script type="module" src="/bundle.js"></script>`;
const server = createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(bundle);
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
}).listen(4173);

const browser = await chromium.launch({ headless: true });
const results = {};
try {
  for (const [name, cfg] of Object.entries(cfgs)) {
    const page = await browser.newPage();
    const console_ = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") console_.push(m.text().slice(0, 200));
    });
    const failed = [];
    page.on("requestfailed", (r) => failed.push(`${r.method()} ${new URL(r.url()).pathname.slice(0, 60)} ${r.failure()?.errorText ?? ""}`));
    await page.goto("http://localhost:4173/");
    await page.waitForFunction(() => typeof window.ckRun === "function");
    const r = await page.evaluate((c) => window.ckRun(c), cfg);
    results[name] = { ...r, browser: browser.version(), console_errors: console_.slice(0, 6), failed_requests: failed.slice(0, 6) };
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(results));
// The port forwarders keep the event loop alive; the run is over.
process.exit(0);
