/**
 * ZK06b and ZK07b against the project ZK01-ZK07 ran on (kept with KEEP=1).
 * Started by ../run-zk-followup.sh.
 *
 * ZK06b: decode what the gateway's edge_logs kept for the wrapper's filtered
 *   requests on /rest/v1/records: the query string, and in it the full
 *   encrypted operand (keys and lengths only are written out).
 * ZK07b: federation (OidcFederationStrategy with the user's Supabase access
 *   token) encrypt and decrypt, then the lock-context bind
 *   ({ identityClaim: ["sub"] }) as user A, a decrypt of A's locked value
 *   as user A and as user B.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, UA_EMAIL/UA_PASS, UB_EMAIL/UB_PASS,
 * REF, SUPABASE_ACCESS_TOKEN (logs only), CS_FED_CRN, OUT.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Encryption } from "@cipherstash/stack/v3";
import { OidcFederationStrategy } from "@cipherstash/stack";
import { encryptedTable, types } from "@cipherstash/stack/eql/v3";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} not set`);
  return v;
};
const out: Record<string, unknown> = { startedAt: new Date().toISOString() };
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const res = (r: { failure?: { type?: string; message?: string } }) =>
  r.failure ? { failure: r.failure.type ?? null, message: String(r.failure.message ?? "").slice(0, 300) } : "ok";

// ---------- ZK06b ----------
{
  const end = new Date(), start = new Date(end.getTime() - 6 * 3600_000);
  const sql =
    "select timestamp, log_attributes['request.method'] as m, log_attributes['request.search'] as s " +
    "from logs where source = 'edge_logs' and log_attributes['request.path'] = '/rest/v1/records' " +
    "and log_attributes['request.search'] like '%=eq.%' order by timestamp asc limit 50";
  const u = `https://api.supabase.com/v1/projects/${env("REF")}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${encodeURIComponent(start.toISOString())}&iso_timestamp_end=${encodeURIComponent(end.toISOString())}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${env("SUPABASE_ACCESS_TOKEN")}` } });
  const j = (await r.json().catch(() => ({}))) as { result?: { m: string; s: string }[]; error?: unknown };
  const rows = (j.result ?? []).map((x) => {
    const params = new URLSearchParams(x.s.replace(/^\?/, ""));
    const ops: Record<string, unknown> = {};
    for (const [k, v] of params) {
      if (!v.startsWith("eq.") || !v.slice(3).startsWith("{")) continue;
      try {
        const o = JSON.parse(v.slice(3));
        ops[k] = { keys: Object.keys(o).sort(), cLen: String(o.c ?? "").length, hmLen: String(o.hm ?? "").length, identifier: o.i ?? null };
      } catch {
        ops[k] = "unparsed";
      }
    }
    return { method: x.m, searchLen: x.s.length, encryptedOperands: ops, plainParams: [...params.keys()].filter((k) => !(k in ops)) };
  });
  out.ZK06b = { status: r.status, error: j.error ? JSON.stringify(j.error).slice(0, 200) : "", rows: rows.length, byMethod: rows.reduce<Record<string, number>>((a, x) => ((a[x.method] = (a[x.method] ?? 0) + 1), a), {}), sample: rows.slice(0, 6) };
}

// ---------- ZK07b ----------
async function signedIn(email: string, pass: string): Promise<SupabaseClient> {
  const c = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: pass });
  if (error) throw new Error(`sign-in: ${error.message}`);
  return c;
}
async function federated(sb: SupabaseClient, t: ReturnType<typeof encryptedTable>) {
  const fed = OidcFederationStrategy.create(env("CS_FED_CRN"), async () => (await sb.auth.getSession()).data.session!.access_token);
  if (fed.failure) return { failure: fed.failure };
  const client = await Encryption({ schemas: [t], config: { authStrategy: fed.data } } as never);
  return { client };
}
{
  const r: Record<string, unknown> = {};
  const t = encryptedTable("records", { subject: types.TextEq("subject") });
  try {
    const sbA = await signedIn(env("UA_EMAIL"), env("UA_PASS"));
    const sbB = await signedIn(env("UB_EMAIL"), env("UB_PASS"));
    const fa = await federated(sbA, t);
    const fb = await federated(sbB, t);
    if ("failure" in fa && fa.failure) {
      r.createA = { failure: (fa.failure as { type?: string }).type ?? null };
    } else {
      const ca = (fa as { client: Awaited<ReturnType<typeof Encryption>> }).client;
      const cb = (fb as { client: Awaited<ReturnType<typeof Encryption>> }).client;
      // plain federated encrypt/decrypt, and B decrypting A's unlocked value
      const e = await ca.encrypt("S-FED" as never, { table: t, column: t.subject } as never);
      r.federatedEncryptA = res(e);
      if (!e.failure) {
        const d = await ca.decrypt(e.data as never);
        r.federatedDecryptA = d.failure ? res(d) : { ok: d.data === "S-FED" };
        const db = await cb.decrypt(e.data as never);
        r.federatedDecryptUnlockedByB = db.failure ? res(db) : { ok: db.data === "S-FED" };
      }
      // lock context: bind to A's sub
      const lc = { identityClaim: ["sub"] };
      let le: { failure?: { type?: string; message?: string }; data?: unknown };
      try {
        le = await (ca.encrypt("S-LOCK" as never, { table: t, column: t.subject } as never) as unknown as { withLockContext: (x: unknown) => Promise<typeof le> }).withLockContext(lc);
      } catch (x) {
        le = { failure: { type: "threw", message: errText(x) } };
      }
      r.lockedEncryptA = res(le);
      if (!le.failure) {
        const run = async (c: typeof ca) => {
          try {
            const op = c.decrypt(le.data as never) as unknown as { withLockContext?: (x: unknown) => Promise<{ failure?: { type?: string; message?: string }; data?: unknown }> };
            const d = op.withLockContext ? await op.withLockContext(lc) : await (op as unknown as Promise<{ failure?: { type?: string; message?: string }; data?: unknown }>);
            return d.failure ? res(d) : { ok: d.data === "S-LOCK" };
          } catch (x) {
            return { threw: errText(x) };
          }
        };
        r.lockedDecryptA = await run(ca);
        r.lockedDecryptB = await run(cb);
      }
    }
  } catch (e) {
    r.threw = errText(e);
  }
  out.ZK07b = r;
}
out.finishedAt = new Date().toISOString();
await Bun.write(env("OUT"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
