// probe2: run 2 matrix. Env: FRONT_URL, SUPABASE_ACCESS_TOKEN (the env-proxy
// phase sets and removes an HTTPS_PROXY secret). Writes evidence/run2-<ts>.json.
import { readFileSync, writeFileSync } from "node:fs";

const dir = import.meta.dir;
const S = JSON.parse(readFileSync(`${dir}/evidence/state.json`, "utf8"));
const FRONT = process.env.FRONT_URL!;
const PAT = process.env.SUPABASE_ACCESS_TOKEN!;
const N = Number(process.env.N ?? 20);
const rows: any[] = [];
const user = { authorization: `Bearer ${S.accessToken}`, apikey: S.publishable, "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fn(id: string, arm: string) {
  const t = performance.now();
  const r = await fetch(`${FRONT}/fn/relay?arm=${arm}`, { method: "POST", headers: user, body: "{}" });
  const body: any = await r.json().catch(async () => await r.text());
  const ms = Math.round(performance.now() - t);
  rows.push({ id, arm, status: r.status, ms, region: r.headers.get("x-sb-edge-region"), body });
  const res = Array.isArray(body?.results) ? body.results : [];
  console.log(`${id} [${r.status} ${ms}ms]`);
  for (const a of res) console.log(`   ${a.ok ? "ok  " : "FAIL"} ${a.arm.padEnd(36)} ${String(a.status ?? "-").padEnd(4)} ${String(a.ms).padStart(5)}ms ${a.error ? a.error.slice(0, 110) : JSON.stringify(a.detail ?? "").slice(0, 110)}`);
  return body;
}

async function rest(id: string, url: string, headers: Record<string, string>) {
  const r = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  const body = await r.json().catch(() => null);
  rows.push({ id, status: r.status, body });
  console.log(`${id} [${r.status}] ${JSON.stringify(body)}`);
}

// Gateway: mTLS (Cloudflare-managed CA) + JWT, two process APIs
await fn("GW1 gateway matrix", "gw");
// Gateway behind Access service token
await fn("SV1 access service token", "svc");
// Runtime behaviour
await fn("P1 proxy option honoured", "proxy");
await fn("V1 X.509 v1 client cert", "v1-cert");
await fn("V2 worker alive after v1 error", "probe");
await fn("E1 explicit-params EC key", "explicit-ec");
// What the function and the database see for the caller's address
await fn("H1 headers seen by function via front", "headers");
const restKey = { apikey: S.publishable, authorization: `Bearer ${S.publishable}` };
await rest("H2 DB-seen headers via front", `${FRONT}/rest/v1/rpc/seen_headers`, restKey);
await rest("H3 DB-seen headers direct", `${S.url}/rest/v1/rpc/seen_headers`, restKey);
await rest("H4 DB-seen headers direct, spoofed", `${S.url}/rest/v1/rpc/seen_headers`, {
  ...restKey, "cf-worker": "spoofed.example", "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8", "x-real-ip": "203.0.113.9",
});

// Latency to a nearby mTLS gateway: reused client vs new client per request
const lat: Record<string, number[]> = { "gw-reuse": [], "gw-new-client": [] };
for (let i = 0; i < N; i++) {
  for (const arm of Object.keys(lat)) {
    const r = await fetch(`${FRONT}/fn/relay?arm=${arm}`, { method: "POST", headers: user, body: "{}" });
    const b: any = await r.json().catch(() => null);
    const inner = b?.results?.[0];
    if (r.status === 200 && inner?.ok) lat[arm].push(inner.ms);
  }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
for (const [arm, a] of Object.entries(lat)) {
  const row = { id: `L ${arm} (in-function outbound ms)`, n: a.length, p50: pct(a, 50), p90: pct(a, 90), max: Math.max(...a), samples: a };
  rows.push(row);
  console.log(`${row.id.padEnd(40)} n=${a.length} p50=${row.p50} p90=${row.p90} max=${row.max}`);
}

// HTTPS_PROXY as a function secret: does plain fetch pick it up?
await fn("X0 env-proxy before secret", "env-proxy");
const mg = (method: string, body: unknown) => fetch(`https://api.supabase.com/v1/projects/${S.ref}/secrets`, {
  method, headers: { authorization: `Bearer ${PAT}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
console.log(`set HTTPS_PROXY secret: ${(await mg("POST", [{ name: "HTTPS_PROXY", value: "http://127.0.0.1:9" }])).status}`);
await sleep(30_000);
for (let i = 1; i <= 3; i++) await fn(`X${i} env-proxy with secret set`, "env-proxy");
console.log(`delete HTTPS_PROXY secret: ${(await mg("DELETE", ["HTTPS_PROXY"])).status}`);

const out = `${dir}/evidence/run2-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), front: FRONT, rows }, null, 2));
console.log(`-> ${out}`);
