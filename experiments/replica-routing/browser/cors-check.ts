/**
 * RR07e browser half: real cross-origin fetches from a page whose origin is
 * neither the Worker host nor the custom host, in headless Chromium. Run as a
 * subprocess by RR07 (Playwright is not a harness dependency):
 *
 *   PVLAB_CORS_SPEC=<base64 JSON> bun browser/cors-check.ts
 *
 * spec: { origin, anon, email, password, bases: { <label>: <https base> } }
 *
 * The page at `origin` is served by page.route, so no host of ours serves it;
 * Chromium enforces CORS as for any site. For each base it signs in with a
 * password (POST /auth/v1/token), reads the RLS view with the session token
 * (GET /rest/v1, preflighted: apikey and Authorization headers), and calls a
 * volatile RPC (POST /rest/v1/rpc). A CORS refusal surfaces as a TypeError in
 * the page and a console error, which is what this records. Prints one JSON line.
 */
import { chromium } from "playwright";

interface Spec {
  origin: string;
  anon: string;
  email: string;
  password: string;
  bases: Record<string, string>;
}
const spec = JSON.parse(Buffer.from(process.env.PVLAB_CORS_SPEC ?? "", "base64").toString("utf8")) as Spec;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  await page.route(`${spec.origin}/**`, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>cors</title><p>cors</p>" }));
  await page.goto(`${spec.origin}/`);
  const results: Record<string, unknown> = {};
  for (const [label, base] of Object.entries(spec.bases)) {
    results[label] = await page.evaluate(
      async ({ base, anon, email, password }) => {
        const out: Record<string, string | number> = {};
        const run = async (name: string, f: () => Promise<Response>, body: (r: Response) => Promise<string>) => {
          try {
            const r = await f();
            out[name] = `${r.status} ${await body(r)}`;
            return r;
          } catch (e) {
            out[name] = `ERR ${String(e).slice(0, 80)}`;
            return null;
          }
        };
        let token = "";
        await run(
          "signin",
          () => fetch(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }),
          async (r) => {
            const j = (await r.json().catch(() => ({}))) as { access_token?: string };
            token = j.access_token ?? "";
            return token ? "token" : "no-token";
          },
        );
        if (!token) return out;
        await run(
          "read",
          () => fetch(`${base}/rest/v1/rr6_docs_v?select=*`, { headers: { apikey: anon, Authorization: `Bearer ${token}` } }),
          async (r) => {
            const rows = (await r.json().catch(() => [])) as { in_recovery: boolean }[];
            return Array.isArray(rows) ? `rows=${rows.length} ${[...new Set(rows.map((x) => (x.in_recovery ? "replica" : "primary")))].join("+")}` : "not-array";
          },
        );
        await run(
          "rpc_post",
          () => fetch(`${base}/rest/v1/rpc/rr6_touch`, { method: "POST", headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }),
          async (r) => {
            const j = (await r.json().catch(() => ({}))) as { in_recovery?: boolean };
            return j.in_recovery === undefined ? "?" : j.in_recovery ? "replica" : "primary";
          },
        );
        return out;
      },
      { base, anon: spec.anon, email: spec.email, password: spec.password },
    );
  }
  console.log(JSON.stringify({ results, consoleErrors }));
} finally {
  await browser.close();
}
