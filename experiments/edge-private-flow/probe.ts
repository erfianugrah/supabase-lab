// probe: the whole-flow matrix. Env: FRONT_URL (the front Worker), reads
// evidence/state.json from setup.ts. Writes evidence/run-<ts>.json.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const S = JSON.parse(readFileSync(`${import.meta.dir}/evidence/state.json`, "utf8"));
const FRONT = process.env.FRONT_URL!;
if (!FRONT) throw new Error("FRONT_URL required");
const N = Number(process.env.N ?? 20);
const rows: any[] = [];

async function call(id: string, expect: string, url: string, headers: Record<string, string> = {}, method = "POST") {
  const t = performance.now();
  const r = await fetch(url, { method, headers, body: method === "POST" ? "{}" : undefined });
  const ms = Math.round(performance.now() - t);
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  const row = {
    id, expect, status: r.status, ms,
    edgeRegion: r.headers.get("x-sb-edge-region"), frontColo: r.headers.get("x-front-colo"), frontMs: r.headers.get("x-front-ms"),
    body,
  };
  rows.push(row);
  console.log(`${id.padEnd(34)} ${String(r.status).padEnd(4)} ${String(ms).padStart(5)}ms region=${row.edgeRegion ?? "-"} colo=${row.frontColo ?? "-"}  expect: ${expect}`);
  return row;
}

const fnDirect = `${S.url}/functions/v1/relay`;
const user = { authorization: `Bearer ${S.accessToken}`, apikey: S.publishable, "content-type": "application/json" };

// Gates
await call("G1 direct, no front secret", "403 front-secret", `${fnDirect}?arm=probe`, user);
await call("G2 direct, wrong front secret", "403 front-secret", `${fnDirect}?arm=probe`, { ...user, "x-gw-secret": "nope" });
await call("G3 via front, no user JWT", "401 jwt", `${FRONT}/fn/relay?arm=probe`, { apikey: S.publishable });
await call("G4 via front, garbage JWT", "401 jwt", `${FRONT}/fn/relay?arm=probe`, { apikey: S.publishable, authorization: "Bearer x.y.z" });

// Flow
await call("F1 via front, probe", "200, createHttpClient=function, region ap-southeast-1", `${FRONT}/fn/relay?arm=probe`, user);
await call("F2 via front, mTLS CA-verified", "no-cert 400, with-cert 200", `${FRONT}/fn/relay?arm=mtls-ca`, user);
await call("F3 via front, mTLS own CA echo", "subject CN=lab-edge-function-client-ec", `${FRONT}/fn/relay?arm=mtls-echo`, user);
await call("F4 via front, JWT upstream", "user-token 200 ok, no-token 401", `${FRONT}/fn/relay?arm=jwt-upstream`, user);

// Region
await call("R1 via front pinned (POST)", "region ap-southeast-1", `${FRONT}/fn/relay?arm=probe`, user);
await call("R2 via front unpinned (POST)", "nearest region", `${FRONT}/fn/relay?arm=probe&pin=0`, user);
await call("R3 direct forceFunctionRegion=us-east-1", "region us-east-1 (pin moves it)", `${fnDirect}?arm=probe&forceFunctionRegion=us-east-1`, { ...user, "x-gw-secret": S.front });

// Data API gating via RLS on request.headers
const rest = { apikey: S.publishable, authorization: `Bearer ${S.publishable}` };
await call("D1 REST via front", "2 rows", `${FRONT}/rest/v1/items?select=*`, rest, "GET");
await call("D2 REST direct, no header", "0 rows", `${S.url}/rest/v1/items?select=*`, rest, "GET");
await call("D3 REST direct, wrong header", "0 rows", `${S.url}/rest/v1/items?select=*`, { ...rest, "x-gw-secret": "nope" }, "GET");
await call("D4 REST direct, user JWT no header", "0 rows", `${S.url}/rest/v1/items?select=*`, { apikey: S.publishable, authorization: `Bearer ${S.accessToken}` }, "GET");

// What stays open
await call("O1 Auth settings direct", "200 (Auth not gated by the front)", `${S.url}/auth/v1/settings`, { apikey: S.publishable }, "GET");
await call("O2 Storage buckets direct", "reachable (not gated)", `${S.url}/storage/v1/bucket`, rest, "GET");

// TLS: does the Supabase edge ask for a client certificate at all?
let tls = "";
try {
  tls = execFileSync("sh", ["-c", `echo | openssl s_client -connect ${S.ref}.supabase.co:443 -servername ${S.ref}.supabase.co 2>&1 | grep -i -E 'client certificate|Acceptable client' | head -3`], { encoding: "utf8" });
} catch (e) { tls = String(e); }
rows.push({ id: "T1 Supabase edge CertificateRequest", expect: "no client cert CA names sent", body: tls.trim() });
console.log(`T1 Supabase edge CertificateRequest   ${tls.trim()}`);

// Latency through the whole chain
const lat: Record<string, number[]> = { probe: [], "jwt-upstream": [], "mtls-echo": [] };
for (const arm of Object.keys(lat)) {
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await fetch(`${FRONT}/fn/relay?arm=${arm}`, { method: "POST", headers: user, body: "{}" });
    await r.text();
    if (r.status === 200) lat[arm].push(Math.round(performance.now() - t));
  }
}
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
for (const [arm, a] of Object.entries(lat)) {
  const row = { id: `L ${arm}`, n: a.length, p50: pct(a, 50), p90: pct(a, 90), max: Math.max(...a), samples: a };
  rows.push(row);
  console.log(`L ${arm.padEnd(14)} n=${a.length} p50=${row.p50}ms p90=${row.p90}ms max=${row.max}ms`);
}

const out = `${import.meta.dir}/evidence/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), front: FRONT, ref: S.ref, alg: S.alg, rows }, null, 2));
console.log(`-> ${out}`);
