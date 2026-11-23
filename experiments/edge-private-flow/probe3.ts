// probe3: run 3 matrix. Env: FRONT_URL, SUPABASE_ACCESS_TOKEN.
// Starts the local tunnel origin and cloudflared itself and stops them at the end.
// Writes evidence/run3-<ts>.json.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const dir = import.meta.dir;
const S = JSON.parse(readFileSync(`${dir}/evidence/state.json`, "utf8"));
const C3 = JSON.parse(readFileSync(`${dir}/evidence/cf3.json`, "utf8"));
const FRONT = process.env.FRONT_URL!;
const PAT = process.env.SUPABASE_ACCESS_TOKEN!;
const N = Number(process.env.N ?? 50);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const rows: any[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const user = { authorization: `Bearer ${S.accessToken}`, apikey: S.publishable, "content-type": "application/json" };

async function fn(id: string, url: string, headers: Record<string, string> = user, quiet = false) {
  const t = performance.now();
  const r = await fetch(url, { method: "POST", headers, body: "{}" });
  const body: any = await r.json().catch(async () => await r.text());
  const row = { id, status: r.status, ms: Math.round(performance.now() - t), region: r.headers.get("x-sb-edge-region"), body };
  rows.push(row);
  if (!quiet) {
    console.log(`${id} [${r.status} ${row.ms}ms region=${row.region ?? "-"}]`);
    for (const a of Array.isArray(body?.results) ? body.results : []) {
      console.log(`   ${a.ok ? "ok  " : "FAIL"} ${a.arm.padEnd(30)} ${String(a.status ?? "-").padEnd(4)} ${String(a.ms).padStart(5)}ms ${a.error ? a.error.slice(0, 100) : JSON.stringify(a.detail ?? "").slice(0, 120)}`);
    }
  }
  return body;
}
const viaFront = (arm: string) => `${FRONT}/fn/relay?arm=${arm}`;

// local origin + tunnel connector
const origin = spawn("bun", ["tunnel-origin.ts"], { cwd: `${dir}/workers/gateway`, env: { ...process.env, SUPABASE_URL: S.url }, stdio: "ignore" });
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "run", "--token", readFileSync(`${dir}/certs/tunnel-token.txt`, "utf8").trim()], { stdio: "ignore" });
try {
  const tun = JSON.parse(readFileSync(`${dir}/certs/tun-token.json`, "utf8"));
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    await sleep(3000);
    const r = await fetch(`https://${C3.tun}/process/rates`, {
      headers: { "CF-Access-Client-Id": tun.id, "CF-Access-Client-Secret": tun.secret, authorization: `Bearer ${S.accessToken}` },
      redirect: "manual",
    }).catch(() => null);
    ready = r?.status === 200;
  }
  console.log(`tunnel ready: ${ready}`);

  // own CA (BYO CA), tunnel
  await fn("OWN1 own-CA gateway matrix", viaFront("own"));
  await fn("TUN1 tunnel + Access matrix", viaFront("tun"));

  // region from abroad: a function forced abroad calls the relay unpinned and via the front
  for (const region of ["us-east-1", "eu-central-1"]) {
    await fn(`ABR ${region}`, `${S.url}/functions/v1/relay?arm=abroad&forceFunctionRegion=${region}`, { ...user, "x-gw-secret": S.front });
  }

  // cert rotation: secret rot-a -> rot-b, no redeploy
  for (const arm of ["rot-new", "rot-reuse"]) await fn(`ROT0 ${arm} before`, viaFront(arm));
  const t0 = Date.now();
  const set = await fetch(`https://api.supabase.com/v1/projects/${S.ref}/secrets`, {
    method: "POST",
    headers: { authorization: `Bearer ${PAT}`, "content-type": "application/json" },
    body: JSON.stringify([{ name: "ROT_CERT", value: readFileSync(`${dir}/certs/rot-b.crt`, "utf8") }, { name: "ROT_KEY", value: readFileSync(`${dir}/certs/rot-b.key`, "utf8") }]),
  });
  console.log(`ROT secret -> rot-b: ${set.status}`);
  const firstB: Record<string, number | null> = { "rot-new": null, "rot-reuse": null };
  const trace: any[] = [];
  while (Date.now() - t0 < 240_000 && Object.values(firstB).some((v) => v === null)) {
    for (const arm of Object.keys(firstB)) {
      const b = await fn(`ROT ${arm}`, viaFront(arm), user, true);
      const subj = b?.results?.[0]?.detail?.subject ?? null;
      const s = Math.round((Date.now() - t0) / 1000);
      trace.push({ arm, s, subj });
      if (firstB[arm] === null && subj === "CN=lab-rot-b") firstB[arm] = s;
    }
    await sleep(5000);
  }
  rows.push({ id: "ROT summary", firstB, trace });
  console.log(`ROT first rot-b seen (s after secret set): ${JSON.stringify(firstB)}; samples ${trace.length}`);

  // latency to the nearby mTLS gateway: reused vs new client, ROUNDS x N interleaved
  for (let round = 1; round <= ROUNDS; round++) {
    const lat: Record<string, number[]> = { "gw-reuse": [], "gw-new-client": [] };
    for (let i = 0; i < N; i++) {
      for (const arm of Object.keys(lat)) {
        const r = await fetch(viaFront(arm), { method: "POST", headers: user, body: "{}" });
        const b: any = await r.json().catch(() => null);
        if (r.status === 200 && b?.results?.[0]?.ok) lat[arm].push(b.results[0].ms);
      }
    }
    for (const [arm, a] of Object.entries(lat)) {
      const s = [...a].sort((x, y) => x - y);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      const row = { id: `LAT r${round} ${arm}`, n: a.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1], samples: a };
      rows.push(row);
      console.log(`${row.id.padEnd(28)} n=${row.n} min=${row.min} p50=${row.p50} p90=${row.p90} max=${row.max}`);
    }
  }
} finally {
  tunnel.kill();
  origin.kill();
  const out = `${dir}/evidence/run3-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), front: FRONT, rows }, null, 2));
  console.log(`-> ${out}`);
}
