/**
 * HG01 - the managed Auth surface an edge-scored, hook-enforced signup rests
 * on: which client IP reaches the before-user-created hook, who can set it,
 * whether a secret-key caller skips CAPTCHA, how a refusing HTTP hook reaches
 * the client, and whether the edge logs carry a TLS fingerprint.
 *
 * Code reads behind each row (supabase/auth at 8872586):
 * internal/utilities/request.go picks Sb-Forwarded-For when forwarding is on
 * and the header is valid, else the LEFTMOST valid X-Forwarded-For entry, and
 * GoTrue trusts XFF from any peer, so what reaches Auth is the edge's choice.
 * internal/sbff/sbff.go does not check the key type; the docs say only secret
 * keys may forward. Measured 2026-11-12 (RUNLOG): with forwarding on, a
 * publishable-key request's XFF did not reach the hook either, which the code
 * alone does not predict. The CAPTCHA check is skipped for admin credentials
 * (api/middleware.go verifyCaptcha). hookshttp.go reads a body only on 200/202.
 *
 * One throwaway Pro-org Micro project, deleted in finally:
 *   setup  a Postgres before-user-created hook that records every event in
 *          public.hg_seen; email autoconfirm and anonymous sign-ins on
 *   HG01a  X-Forwarded-For on /auth/v1/signup: the IP the hook sees with no
 *          header, one client entry, two client entries (publishable key), and
 *          one entry with the secret key. Labels: `client value` = the XFF
 *          value sent, `edge value` = what the no-header control signup saw
 *   HG01b  Sb-Forwarded-For with forwarding on: the IP the hook sees per key
 *          (secret, publishable, legacy anon, legacy service_role), on email
 *          signup and anonymous sign-in, and in auth.audit_log_entries for a
 *          password sign-in
 *   HG01c  CAPTCHA on with Turnstile's always-fail test secret: signup status
 *          per key with no token
 *   HG01d  an HTTP before-user-created hook (Edge Function) refusing with
 *          200 + error body vs 400: the status and message the client gets
 *   HG01e  signup options.data reaches the hook as user.user_metadata
 *   HG01f  an anonymous sign-in with data fires the hook
 *   HG01g  request.cf fields (JA4, bot score) in the project's edge logs
 *
 * Destructive (creates a billed project): --destructive and PVLAB_ORG_PRO.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { logsQuery, sql } from "../../../harness/src/platform";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { destroyProject, patchAuthConfig, provisionProject, type Rig } from "../../auth-providers/lib/rig";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Turnstile's documented test secrets: "always fails" (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
const TURNSTILE_ALWAYS_FAIL = "2x0000000000000000000000000000000AA";
// Documentation ranges (RFC 5737), so no real client is ever named.
const XFF_A = "198.51.100.7";
const XFF_B = "198.51.100.8";

type KeyKind = "publishable" | "secret" | "anon" | "service_role";

interface Call {
  status: number;
  json?: any;
  text: string;
}

function headersFor(rig: Rig, key: KeyKind): Record<string, string> {
  const k = rig.keys;
  if (key === "publishable") return { apikey: k.publishable! };
  if (key === "secret") return { apikey: k.secret! };
  if (key === "anon") return { apikey: k.anon, Authorization: `Bearer ${k.anon}` };
  return { apikey: k.service, Authorization: `Bearer ${k.service}` };
}

async function call(rig: Rig, path: string, key: KeyKind, body: unknown, extra: Record<string, string> = {}): Promise<Call> {
  const res = await fetch(`https://${rig.ctx.apiHost}/auth/v1${path}`, {
    method: "POST",
    headers: { ...headersFor(rig, key), "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text: text.slice(0, 300) };
}

const code = (c: Call) => String(c.json?.error_code ?? c.json?.code ?? "");
const msg = (c: Call) => String(c.json?.msg ?? c.json?.message ?? c.json?.error_description ?? "").slice(0, 120);
const short = (c: Call) => (c.status < 300 ? String(c.status) : `${c.status}:${code(c) || "-"}`);

let seq = 0;
function newMarker(): { marker: string; email: string } {
  const marker = crypto.randomUUID();
  seq += 1;
  return { marker, email: `hg-${marker.slice(0, 8)}-${seq}@example.com` };
}

/** The event the hook recorded for this marker, or undefined. */
async function seen(rig: Rig, marker: string): Promise<any> {
  const r = await sql(rig.ctx, `select event from public.hg_seen where event #>> '{user,user_metadata,hg_marker}' = '${marker}' order by id desc limit 1`);
  return r.rows[0]?.event;
}

async function seenIp(rig: Rig, marker: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const e = await seen(rig, marker);
    if (e) return String(e.metadata?.ip_address ?? "(no ip)");
    await sleep(1_000);
  }
  return "(no event)";
}

/** Email signup with a fresh marker; returns the call and the IP the hook saw. */
async function emailSignup(rig: Rig, key: KeyKind, extra: Record<string, string> = {}, data: Record<string, unknown> = {}) {
  const { marker, email } = newMarker();
  const c = await call(rig, "/signup", key, { email, password: `Pw-${marker}`, data: { hg_marker: marker, ...data } }, extra);
  return { c, marker, email, ip: c.status < 300 ? await seenIp(rig, marker) : "(refused)" };
}

async function anonSignin(rig: Rig, key: KeyKind, extra: Record<string, string> = {}) {
  const { marker } = newMarker();
  const c = await call(rig, "/signup", key, { data: { hg_marker: marker } }, extra);
  return { c, marker, ip: c.status < 300 ? await seenIp(rig, marker) : "(refused)" };
}

/** Retry `attempt` every 4 s until `done` or the budget runs out; returns seconds waited or -1. */
async function until(budgetMs: number, attempt: () => Promise<boolean>): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (await attempt()) return Math.round((Date.now() - t0) / 1000);
    await sleep(4_000);
  }
  return -1;
}

/** The client IP Cloudflare sees for a request to `host` (its /cdn-cgi/trace). */
async function traceIp(host: string): Promise<string> {
  const t = await fetch(`https://${host}/cdn-cgi/trace`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(() => "");
  return /^ip=(.+)$/m.exec(t)?.[1] ?? "unknown";
}

const SETUP_SQL = `
create table public.hg_seen (id bigserial primary key, at timestamptz not null default now(), event jsonb not null);
alter table public.hg_seen enable row level security;
revoke all on public.hg_seen from anon, authenticated;
create or replace function public.hg_hook(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.hg_seen(event) values (event);
  return '{}'::jsonb;
end $$;
revoke execute on function public.hg_hook(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.hg_hook(jsonb) to supabase_auth_admin;
`;

// HTTP hook: refuses per user_metadata.hg_mode, records nothing.
const HTTP_HOOK = `
Deno.serve(async (req) => {
  const event = await req.json().catch(() => ({}));
  const mode = event?.user?.user_metadata?.hg_mode ?? "ok";
  const refusal = (http_code, message) => ({ error: { http_code, message } });
  if (mode === "200-403") return Response.json(refusal(403, "hg refusal 200-403"));
  if (mode === "200-429") return Response.json(refusal(429, "hg refusal 200-429"));
  if (mode === "400-403") return Response.json(refusal(403, "hg refusal 400-403"), { status: 400 });
  return Response.json({});
});
`;

const mod: TestModule = {
  id: "HG01",
  title: "Hook-gated signup surface on managed Auth (XFF, Sb-Forwarded-For, CAPTCHA skip, HTTP hook refusal, edge logs)",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx) {
    const org = ctx.orgs.pro;
    if (!org) return { id: "HG01", title: "HG01", status: "skip", detail: "PVLAB_ORG_PRO not set" };
    const results: TestResult[] = [];
    const push = (r: TestResult) => results.push(r);
    let rig: Rig | undefined;
    try {
      rig = await provisionProject(ctx, org, "hg01", { pro: true, prefix: "hg" });
      const r = rig;
      const setup = await sql(r.ctx, SETUP_SQL);
      if (setup.status >= 300) throw new Error(`setup SQL: ${setup.error}`);
      const p1 = await patchAuthConfig(r, {
        mailer_autoconfirm: true,
        external_anonymous_users_enabled: true,
        hook_before_user_created_enabled: true,
        hook_before_user_created_uri: "pg-functions://postgres/public/hg_hook",
      });
      if (p1.status >= 300) throw new Error(`auth config: HTTP ${p1.status} ${p1.text}`);

      // Control: wait until the hook records a plain publishable signup.
      let control = { c: { status: 0, text: "" } as Call, marker: "", email: "", ip: "" };
      const hookS = await until(180_000, async () => {
        control = await emailSignup(r, "publishable");
        return control.ip !== "(no event)" && control.ip !== "(refused)";
      });
      // The project host's own trace: the client address Cloudflare sees on this path.
      const egress = await traceIp(r.ctx.apiHost);

      // ---- HG01a: X-Forwarded-For, forwarding off (the default) ----
      const xOne = await emailSignup(r, "publishable", { "X-Forwarded-For": XFF_A });
      const xTwo = await emailSignup(r, "publishable", { "X-Forwarded-For": `${XFF_A}, ${XFF_B}` });
      const xSecret = await emailSignup(r, "secret", { "X-Forwarded-For": XFF_A });
      const chosen = (ip: string) => (ip === XFF_A ? "client value" : ip === control.ip ? "edge value" : ip);
      push({
        id: "HG01a",
        title: "X-Forwarded-For from the client: the IP the before-user-created hook sees (forwarding off)",
        status: hookS < 0 ? "fail" : "pass",
        detail: hookS < 0 ? "the hook never recorded a control signup" : `one entry -> ${chosen(xOne.ip)}; two entries -> ${chosen(xTwo.ip)}; secret key + XFF -> ${chosen(xSecret.ip)}`,
        measurements: {
          hook_live_after_s: hookS,
          control_status: short(control.c),
          control_ip_is_client: String(control.ip === egress),
          xff_one_entry: chosen(xOne.ip),
          xff_two_entries: chosen(xTwo.ip),
          xff_secret_key: chosen(xSecret.ip),
        },
        evidence: `client (project-host trace) family ${egress.includes(":") ? "v6" : "v4"}; control ip family ${control.ip.includes(":") ? "v6" : "v4"}; control ip private ${/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|fc|fd)/.test(control.ip)}; statuses ${short(xOne.c)} ${short(xTwo.c)} ${short(xSecret.c)}`,
      });

      // ---- HG01e: options.data -> user.user_metadata ----
      const withData = await emailSignup(r, "publishable", {}, { hg_nested: { a: 1, b: ["x"] }, hg_flag: true });
      const ev = await seen(r, withData.marker);
      const um = ev?.user?.user_metadata ?? {};
      const dataOk = um.hg_flag === true && JSON.stringify(um.hg_nested) === JSON.stringify({ a: 1, b: ["x"] });
      push({
        id: "HG01e",
        title: "Email signup options.data reaches the hook as user.user_metadata",
        status: ev ? (dataOk ? "pass" : "fail") : "fail",
        detail: ev ? `user_metadata keys: ${Object.keys(um).sort().join(",")}` : "no event recorded",
        measurements: { signup: short(withData.c), data_intact: String(dataOk), metadata_keys: Object.keys(ev?.metadata ?? {}).sort().join(",") },
      });

      // ---- HG01f: anonymous sign-in fires the hook ----
      const anon = await anonSignin(r, "publishable");
      const anonEv = await seen(r, anon.marker);
      push({
        id: "HG01f",
        title: "Anonymous sign-in with data fires before-user-created",
        status: anonEv ? "pass" : "fail",
        detail: anonEv ? `is_anonymous=${anonEv.user?.is_anonymous}; marker in user_metadata` : `no event (sign-in ${short(anon.c)})`,
        measurements: { signin: short(anon.c), hook_fired: String(Boolean(anonEv)), is_anonymous: String(anonEv?.user?.is_anonymous ?? "-") },
      });

      // ---- HG01b: Sb-Forwarded-For per key, forwarding on ----
      const p2 = await patchAuthConfig(r, { security_sb_forwarded_for_enabled: true });
      let probe = { c: { status: 0, text: "" } as Call, marker: "", email: "", ip: "" };
      const sbffS = await until(180_000, async () => {
        probe = await emailSignup(r, "secret", { "Sb-Forwarded-For": "203.0.113.9" });
        return probe.ip === "203.0.113.9";
      });
      const sb = (ip: string, sent: string) => (ip === sent ? "honoured" : ip === control.ip ? "ignored (edge value)" : ip === XFF_A ? "ignored (XFF value)" : ip);
      const rows: [string, string][] = [];
      const kinds: KeyKind[] = ["secret", "publishable", "anon", "service_role"];
      let n = 20;
      for (const k of kinds) {
        n += 1;
        const e = await emailSignup(r, k, { "Sb-Forwarded-For": `203.0.113.${n}` });
        rows.push([`signup_${k}`, e.c.status < 300 ? sb(e.ip, `203.0.113.${n}`) : short(e.c)]);
        n += 1;
        const a = await anonSignin(r, k, { "Sb-Forwarded-For": `203.0.113.${n}` });
        rows.push([`anon_${k}`, a.c.status < 300 ? sb(a.ip, `203.0.113.${n}`) : short(a.c)]);
      }
      // Publishable with both headers: which one wins once forwarding is on.
      n += 1;
      const both = await emailSignup(r, "publishable", { "Sb-Forwarded-For": `203.0.113.${n}`, "X-Forwarded-For": XFF_A });
      rows.push(["signup_publishable_with_xff", both.c.status < 300 ? sb(both.ip, `203.0.113.${n}`) : short(both.c)]);
      const xOn = await emailSignup(r, "publishable", { "X-Forwarded-For": XFF_A });
      rows.push(["xff_only_forwarding_on", chosen(xOn.ip)]);
      // Password sign-in: audit log ip_address per key.
      const login = await emailSignup(r, "secret");
      const loginRows: [string, string][] = [];
      for (const k of ["secret", "publishable"] as KeyKind[]) {
        n += 1;
        const sent = `203.0.113.${n}`;
        const t = await call(r, "/token?grant_type=password", k, { email: login.email, password: `Pw-${login.marker}` }, { "Sb-Forwarded-For": sent });
        await sleep(1_500);
        const a = await sql(
          r.ctx,
          `select ip_address from auth.audit_log_entries where payload->>'action' = 'login' and payload->>'actor_username' = '${login.email}' order by created_at desc limit 1`,
        );
        const ip = String(a.rows[0]?.ip_address ?? "(no audit row)");
        loginRows.push([`login_${k}`, t.status < 300 ? (ip === sent ? "honoured" : ip === "(no audit row)" ? ip : ip === control.ip ? "ignored (edge value)" : ip) : short(t)]);
      }
      const audit = await sql(r.ctx, "select count(*)::int as n from auth.audit_log_entries");
      loginRows.push(["audit_rows_total", String(audit.rows[0]?.n ?? audit.error)]);
      const all = [...rows, ...loginRows];
      const leak = all.filter(([k, v]) => !k.startsWith("signup_secret") && !k.startsWith("anon_secret") && !k.startsWith("login_secret") && v === "honoured");
      push({
        id: "HG01b",
        title: "Sb-Forwarded-For with forwarding on: honoured per key and route",
        status: sbffS < 0 ? "fail" : "pass",
        detail:
          sbffS < 0
            ? `secret-key forwarding never took effect (last ip ${probe.ip})`
            : leak.length
              ? `honoured for a non-secret key: ${leak.map(([k]) => k).join(", ")}`
              : "honoured only for the secret key",
        measurements: { forwarding_live_after_s: sbffS, patch_status: p2.status, ...Object.fromEntries(all) },
      });

      // ---- HG01c: CAPTCHA skip per key ----
      const p3 = await patchAuthConfig(r, { security_captcha_enabled: true, security_captcha_provider: "turnstile", security_captcha_secret: TURNSTILE_ALWAYS_FAIL });
      let gate: Call = { status: 0, text: "" };
      const capS = await until(180_000, async () => {
        const { marker, email } = newMarker();
        gate = await call(r, "/signup", "publishable", { email, password: `Pw-${marker}`, data: { hg_marker: marker }, gotrue_meta_security: { captcha_token: "XXXX.DUMMY.TOKEN.XXXX" } });
        return gate.status === 400 && /captcha/i.test(code(gate) + msg(gate));
      });
      const capRows: Record<string, string> = {};
      for (const k of kinds) {
        const e = await emailSignup(r, k);
        capRows[`signup_${k}_no_token`] = short(e.c);
        const a = await anonSignin(r, k);
        capRows[`anon_${k}_no_token`] = short(a.c);
      }
      await patchAuthConfig(r, { security_captcha_enabled: false });
      push({
        id: "HG01c",
        title: "CAPTCHA on (always-fail secret): signup and anonymous sign-in per key with no token",
        status: capS < 0 ? "fail" : "pass",
        detail: capS < 0 ? `CAPTCHA never took effect (last ${short(gate)} ${msg(gate)})` : `secret key: ${capRows.signup_secret_no_token}; publishable: ${capRows.signup_publishable_no_token}`,
        measurements: { patch_status: p3.status, captcha_live_after_s: capS, gate: short(gate), ...capRows },
      });

      // ---- HG01d: HTTP hook refusal shapes ----
      const dep = await deployViaApi(r.ctx, "hg-hook", [{ name: "index.ts", content: HTTP_HOOK }], { entrypoint_path: "index.ts", name: "hg-hook", verify_jwt: false });
      if (dep.status >= 300) throw new Error(`deploy hg-hook: HTTP ${dep.status} ${dep.error}`);
      const hookSecret = `v1,whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
      const p4 = await patchAuthConfig(r, {
        hook_before_user_created_uri: `https://${r.ctx.apiHost}/functions/v1/hg-hook`,
        hook_before_user_created_secrets: hookSecret,
      });
      const modeCall = (mode: string) => {
        const { marker, email } = newMarker();
        return call(r, "/signup", "publishable", { email, password: `Pw-${marker}`, data: { hg_marker: marker, hg_mode: mode } });
      };
      let first: Call = { status: 0, text: "" };
      const httpS = await until(180_000, async () => {
        first = await modeCall("200-403");
        return first.status === 403;
      });
      const shapes: Record<string, string> = {};
      for (const mode of ["200-403", "200-429", "400-403", "ok"]) {
        const c = await modeCall(mode);
        shapes[`mode_${mode}`] = `${c.status} ${code(c) || "-"} "${msg(c)}"`;
      }
      push({
        id: "HG01d",
        title: "HTTP before-user-created hook refusing with 200 + error body vs 400: what the client gets",
        status: httpS < 0 ? "fail" : "pass",
        detail: httpS < 0 ? `the HTTP hook never refused (last ${short(first)} ${msg(first)})` : `200 body http_code 403 -> ${shapes["mode_200-403"]}; 400 reply -> ${shapes["mode_400-403"]}`,
        measurements: { patch_status: p4.status, http_hook_live_after_s: httpS, ...shapes },
      });

      // ---- HG01g: request.cf fields in edge logs ----
      const KEYS = `select arrayFilter(k -> position(k, 'cf') > 0, mapKeys(log_attributes)) as keys from logs where source = 'edge_logs' and position(event_message, '/auth/v1/signup') > 0 limit 1`;
      const FIELDS = `select log_attributes['request.cf.botManagement.ja4'] as ja4, log_attributes['request.cf.botManagement.score'] as bot_score, log_attributes['request.cf.asn'] as asn from logs where source = 'edge_logs' and position(event_message, '/auth/v1/signup') > 0 limit 1`;
      let keys = { status: 0, rows: [] as any[], error: "" };
      const logsS = await until(300_000, async () => {
        keys = await logsQuery(r.ctx, KEYS, 1);
        // A query the endpoint rejects will not start working by waiting.
        return keys.rows.length > 0 || keys.error !== "";
      });
      const fields = await logsQuery(r.ctx, FIELDS, 1);
      const cfKeys: string[] = Array.isArray(keys.rows[0]?.keys) ? (keys.rows[0].keys as string[]) : [];
      const f = fields.rows[0] ?? {};
      push({
        id: "HG01g",
        title: "request.cf in the project's edge logs: JA4 and bot score present?",
        status: logsS < 0 || keys.error ? "fail" : "pass",
        detail:
          logsS < 0 || keys.error
            ? `no edge log row for /auth/v1/signup (${keys.status} ${keys.error || "none within 5 min"})`
            : `ja4 key ${cfKeys.some((k) => /ja4/i.test(k)) ? "present" : "absent"}; botManagement keys ${cfKeys.filter((k) => /botManagement/i.test(k)).length}; ${cfKeys.length} cf keys`,
        measurements: {
          logs_after_s: logsS,
          cf_key_count: cfKeys.length,
          ja4_value: f.ja4 ? "non-empty" : "empty",
          bot_score_value: f.bot_score ? "non-empty" : "empty",
          asn_value: f.asn ? "non-empty" : "empty",
        },
        evidence: `cf keys: ${cfKeys.sort().join(", ")}${fields.error ? `; fields error: ${fields.error}` : ""}`,
      });
    } catch (e) {
      push({ id: "HG01", title: "HG01 setup or probe error", status: "fail", detail: String((e as Error).message ?? e).slice(0, 400) });
    } finally {
      if (rig) {
        const d = await destroyProject(ctx, rig.ref);
        push({ id: "HG01z", title: "cleanup: project deleted", status: d < 300 ? "pass" : "fail", measurements: { delete_status: d } });
      }
    }
    return results;
  },
};

export default mod;
