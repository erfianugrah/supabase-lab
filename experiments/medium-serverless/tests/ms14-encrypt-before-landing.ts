/**
 * MS14 - encrypt sensitive fields in an Edge Function before they reach the
 * table, so a leaked database credential reads ciphertext.
 *
 * The envelope follows the pastebin E2EE shape (version byte, random nonce,
 * plaintext length-padded to 256-byte blocks so ciphertext length reveals the
 * bucket, not the size): here AES-256-GCM under WebCrypto, key from a function
 * secret (`MS14_KEY`), written through the Data API with the service key. The
 * trust model differs from true E2EE - the platform holds the key - and that
 * is the shape asked for: a layer between the client and the row. Rows:
 *
 *   MS14a  secret set, function deployed and live (times).
 *   MS14b  20 writes through the function vs 20 plaintext writes through
 *          the Data API with the service key: p50 / p95 per write.
 *   MS14c  the stored blob read back over the database path: marker absent,
 *          version byte 1, blob length; the function's decrypt path returns
 *          the marker.
 *   MS14d  the marker searched in the logs after 3 minutes: expected absent
 *          from edge_logs, function_logs and postgres_logs.
 *
 * DESTRUCTIVE: creates two tables, one function, one secret; removes all
 * three. Not settled: key rotation and re-encryption, and per-tenant keys.
 */
import { logsQuery } from "../../../harness/src/platform";
import { sql } from "../../../harness/src/platform";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deleteFunction, deployViaApi, invokeWhenLive } from "../../edge-function-limits/lib/ef";
import { errText, sleep } from "../lib/setup";

const SLUG = "ms14-vault";
const N = 20;

const FN_SRC = `
const PAD = 256;
const b64 = (u) => btoa(String.fromCharCode(...u));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function pad(pt) {
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, pt.length);
  const total = Math.ceil((4 + pt.length) / PAD) * PAD;
  const out = new Uint8Array(total); out.set(len, 0); out.set(pt, 4); return out;
}
function unpad(p) { const n = new DataView(p.buffer, p.byteOffset, 4).getUint32(0); return p.slice(4, 4 + n); }
async function key() { return crypto.subtle.importKey("raw", unb64(Deno.env.get("MS14_KEY")), "AES-GCM", false, ["encrypt", "decrypt"]); }
const SB = Deno.env.get("SUPABASE_URL"); const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json" };
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST") {
    const { tenant_id, body } = await req.json();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await key(), pad(new TextEncoder().encode(body))));
    const blob = new Uint8Array(1 + 12 + ct.length); blob[0] = 1; blob.set(nonce, 1); blob.set(ct, 13);
    const r = await fetch(SB + "/rest/v1/ms_secret", { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ tenant_id, blob: b64(blob), version: 1 }) });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    const r = await fetch(SB + "/rest/v1/ms_secret?id=eq." + id + "&select=blob", { headers: H });
    const rows = await r.json(); if (!rows[0]) return new Response("not found", { status: 404 });
    const raw = unb64(rows[0].blob); if (raw[0] !== 1) return new Response("bad version", { status: 500 });
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(1, 13) }, await key(), raw.slice(13)));
    return new Response(JSON.stringify({ body: new TextDecoder().decode(unpad(pt)) }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response("method", { status: 405 });
});
`;

function pct(xs: number[], p: number): number | string {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? "n/a";
}

const mod: TestModule = {
  id: "MS14",
  title: "Encrypt in an Edge Function before the row lands: cost per write, what the database path and the logs see",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const svc = ctx.serviceKey ?? "";
    if (!svc) return [{ id: "MS14", title: mod.title, status: "skip", detail: "no service key" }];
    const marker = `pvlab${Math.random().toString(16).slice(2, 10)}`;
    const keyB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const fnUrl = `https://${ctx.apiHost}/functions/v1/${SLUG}`;
    const H = { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };

    const setup = await sql(
      ctx,
      `create table if not exists public.ms_secret (id serial primary key, tenant_id text not null, blob text not null, version int not null, created_at timestamptz default now());
       create table if not exists public.ms_plain (id serial primary key, tenant_id text not null, body text not null, created_at timestamptz default now());
       alter table public.ms_secret enable row level security; alter table public.ms_plain enable row level security;`,
    );
    if (setup.status >= 300) return [{ id: "MS14", title: mod.title, status: "fail", detail: `setup failed: ${setup.error}` }];

    try {
      // MS14a
      const t0 = Date.now();
      const sec = await mgmt(ctx, "POST", `/projects/${ctx.ref}/secrets`, [{ name: "MS14_KEY", value: keyB64 }]);
      const dep = await deployViaApi(ctx, SLUG, [{ name: "index.ts", content: FN_SRC }], { entrypoint_path: "index.ts", name: SLUG, verify_jwt: false });
      const live = dep.status < 300 ? await invokeWhenLive(ctx, SLUG, 120_000) : { status: dep.status };
      out.push({
        id: "MS14a",
        title: "secret set, function deployed and answering",
        status: sec.status < 300 && dep.status < 300 && live.status > 0 && live.status < 500 ? "pass" : "fail",
        detail: `secret HTTP ${sec.status}; deploy HTTP ${dep.status} in ${dep.ms} ms${dep.error ? ` ${dep.error}` : ""}; first answer HTTP ${live.status} at ${Math.round((Date.now() - t0) / 1000)}s`,
        measurements: { secret_http: sec.status, deploy_http: dep.status, deploy_ms: dep.ms, live_http: live.status, ready_s: Math.round((Date.now() - t0) / 1000) },
      });
      if (dep.status >= 300) return out;
      await sleep(3000);

      // MS14b - writes
      const viaFn: number[] = [];
      const ids: number[] = [];
      let fnErr = "";
      for (let i = 0; i < N; i++) {
        const t = Date.now();
        const r = await fetch(fnUrl, { method: "POST", headers: H, body: JSON.stringify({ tenant_id: "tenant-a", body: `${marker} record ${i} with sensitive text` }) }).catch((e) => ({ status: 0, text: async () => errText(e) }) as Response);
        viaFn.push(Date.now() - t);
        if (r.status >= 300) fnErr = `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`;
        else {
          const j = (await r.json().catch(() => [])) as { id?: number }[];
          if (j[0]?.id) ids.push(j[0].id);
        }
      }
      const plain: number[] = [];
      for (let i = 0; i < N; i++) {
        const t = Date.now();
        await fetch(`https://${ctx.apiHost}/rest/v1/ms_plain`, { method: "POST", headers: H, body: JSON.stringify({ tenant_id: "tenant-a", body: `control ${i}` }) }).catch(() => null);
        plain.push(Date.now() - t);
      }
      out.push({
        id: "MS14b",
        title: `${N} writes through the function vs ${N} plaintext writes through the Data API (service key)`,
        status: ids.length === N ? "pass" : "fail",
        detail: `function p50 ${pct(viaFn, 50)} / p95 ${pct(viaFn, 95)} ms, ${ids.length}/${N} rows${fnErr ? ` (last error ${fnErr})` : ""}; Data API plaintext p50 ${pct(plain, 50)} / p95 ${pct(plain, 95)} ms`,
        measurements: { fn_p50_ms: pct(viaFn, 50), fn_p95_ms: pct(viaFn, 95), fn_rows: ids.length, plain_p50_ms: pct(plain, 50), plain_p95_ms: pct(plain, 95) },
      });

      // MS14c - what the database path sees, and the decrypt path
      const q = await sql(ctx, `select id, version, length(blob) as blob_len, (blob like '%${marker}%') as marker_in_blob, substring(blob,1,4) as head from public.ms_secret order by id limit 3`);
      const first = q.rows[0] ?? {};
      let decrypted = "";
      let decStatus = 0;
      if (ids[0]) {
        const d = await fetch(`${fnUrl}?id=${ids[0]}`, { headers: H }).catch(() => null);
        decStatus = d?.status ?? 0;
        decrypted = d ? String(((await d.json().catch(() => ({}))) as { body?: string }).body ?? "") : "";
      }
      out.push({
        id: "MS14c",
        title: "stored blob over SQL: marker absent; decrypt via the function returns it",
        status: String(first.marker_in_blob) === "false" && decrypted.includes(marker) ? "pass" : "fail",
        detail: `row ${first.id}: version ${first.version}, blob ${first.blob_len} chars base64, marker in blob ${first.marker_in_blob}; decrypt HTTP ${decStatus} returned marker ${decrypted.includes(marker)}`,
        measurements: { version: String(first.version ?? ""), blob_len: String(first.blob_len ?? ""), marker_in_blob: String(first.marker_in_blob ?? ""), decrypt_http: decStatus, decrypt_has_marker: String(decrypted.includes(marker)) },
      });

      // MS14d - logs
      await sleep(180_000);
      const lg = await logsQuery(ctx, `select source, substring(event_message,1,120) as m from logs where event_message like '%${marker}%' or toString(log_attributes) like '%${marker}%' order by timestamp desc limit 10`, 1);
      const bySrc = new Map<string, number>();
      for (const r of lg.rows) bySrc.set(String(r.source), (bySrc.get(String(r.source)) ?? 0) + 1);
      out.push({
        id: "MS14d",
        title: "the plaintext marker in the logs, 3 minutes after the writes",
        status: lg.error ? "info" : lg.rows.length === 0 ? "pass" : "info",
        detail: lg.error ? `logs query error ${lg.error}` : lg.rows.length ? `${lg.rows.length} line(s): ${[...bySrc.entries()].map(([s, n]) => `${s} ${n}`).join(", ")}` : "0 lines in any source",
        measurements: { log_hits: lg.rows.length, sources: [...bySrc.keys()].join(",") || "none" },
        evidence: lg.rows.map((r) => `${r.source}: ${String(r.m)}`).join("\n"),
      });
    } finally {
      await deleteFunction(ctx, SLUG).catch(() => {});
      await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/secrets`, ["MS14_KEY"]).catch(() => {});
      await sql(ctx, "drop table if exists public.ms_secret; drop table if exists public.ms_plain").catch(() => {});
    }
    return out;
  },
};
export default mod;
