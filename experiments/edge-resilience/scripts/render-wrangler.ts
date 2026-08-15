/**
 * Renders worker/wrangler.jsonc from the tofu-created project ref and the
 * public JWKS key. Idempotent; worker-deploy runs it every time so the file
 * can never drift from the tofu state.
 *
 * Usage: bun scripts/render-wrangler.ts <project-ref>
 */
import { readFileSync, writeFileSync } from "node:fs";

const ref = process.argv[2];
if (!ref || !/^[a-z]{20}$/.test(ref)) {
  console.error("usage: bun scripts/render-wrangler.ts <project-ref>");
  process.exit(1);
}

const dir = new URL("../", import.meta.url).pathname;
const jwk = JSON.parse(readFileSync(`${dir}jwks/public.json`, "utf8"));

// workers.dev subdomain is read from the existing render if present, so
// re-renders stay stable; wrangler prints it on first deploy.
let prior: Record<string, any> = {};
try {
  prior = JSON.parse(readFileSync(`${dir}wrangler.jsonc`, "utf8"));
} catch {
  prior = {};
}

const cfg = {
  name: "edge-resilience-drill",
  main: "worker/worker.ts",
  compatibility_date: "2026-01-01",
  workers_dev: true,
  vars: {
    UPSTREAM: `https://${ref}.supabase.co`,
    JWKS_JSON: JSON.stringify(jwk),
    OUTAGE: "false",
    EDGE_URL: prior?.vars?.EDGE_URL ?? "",
  },
};

writeFileSync(`${dir}wrangler.jsonc`, JSON.stringify(cfg, null, 2));
console.log(`wrangler.jsonc rendered for upstream ${cfg.vars.UPSTREAM}`);
