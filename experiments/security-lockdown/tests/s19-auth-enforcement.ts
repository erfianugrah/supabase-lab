/**
 * S19 - Auth protections ENFORCED, not just settable: HIBP at signup, an
 * anonymous-sign-in rate limit at its 429, the CAPTCHA gate, and a
 * before-user-created hook as a Postgres function.
 *
 * Managed project. GoTrue via /auth/v1 with the legacy anon JWT as apikey;
 * config via PATCH /projects/{ref}/config/auth. mailer_autoconfirm is on for
 * the module so no signup sends an email (the shared SMTP allows 2/hour).
 *
 *   S19a  HIBP at SIGNUP: a breached password -> 422 weak_password; a strong
 *         one -> 200 (the half S11 could not drive)
 *   S19b  rate_limit_anonymous_users lowered to 3, then 15 anonymous
 *         sign-ins: how many 200 before the first 429, and the 429 body
 *   S19c  CAPTCHA: Turnstile's documented always-fail test secret -> signup
 *         and password login without a token refused; with a token still
 *         refused; always-pass secret + the dummy token -> 200
 *   S19d  before-user-created hook (pg-functions URI) rejecting a disposable
 *         domain: blocked domain -> the hook's http_code + message; allowed
 *         domain -> 200
 *
 * Not settled by this module: the burst allowance on the anonymous limit
 * (docs: per hour, with a burst); the HTTP-hook variant (an Edge Function
 * endpoint) - the Postgres-function hook is the one driven.
 *
 * DESTRUCTIVE: PATCHes auth config (restored), creates users (deleted), a
 * hook function (dropped).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, httpBody, errCode, sql, waitFor } from "../lib/sec.js";

const TURNSTILE_FAIL = "2x0000000000000000000000000000000AA";
const TURNSTILE_PASS = "1x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const RESTORE = [
  "mailer_autoconfirm", "password_hibp_enabled", "external_anonymous_users_enabled", "rate_limit_anonymous_users",
  "security_captcha_enabled", "security_captcha_provider", "hook_before_user_created_enabled", "hook_before_user_created_uri",
] as const;
const nonce = () => Math.random().toString(36).slice(2, 10);

const mod: TestModule = {
  id: "S19",
  title: "auth enforcement: HIBP at signup, anonymous rate limit 429, CAPTCHA gate, before-user-created hook",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const users: string[] = [];
    const base = (await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`)).json as Record<string, unknown>;
    const patch = (b: Record<string, unknown>) => mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, b);
    const signup = (body: Record<string, unknown>) => httpBody(`https://${ctx.apiHost}/auth/v1/signup`, { method: "POST", key: keys.anonJwt, body });
    const login = (email: string, password: string, extra: Record<string, unknown> = {}) =>
      httpBody(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, { method: "POST", key: keys.anonJwt, body: { email, password, ...extra } });
    const remember = (r: { json: unknown }) => {
      const j = r.json as { id?: string; user?: { id?: string } } | undefined;
      const id = j?.user?.id ?? j?.id;
      if (id) users.push(id);
    };
    const strongPw = () => `S19-${nonce()}-${nonce()}-Qz!`;
    let hookInstalled = false;
    try {
      // S19a - HIBP at signup
      const p1 = await patch({ mailer_autoconfirm: true, password_hibp_enabled: true });
      let breached = await signup({ email: `s19a-${nonce()}@example.com`, password: "passwordpassword" });
      remember(breached);
      const enforced = await waitFor(async () => {
        if (breached.status === 422) return true;
        breached = await signup({ email: `s19a-${nonce()}@example.com`, password: "passwordpassword" });
        remember(breached);
        return breached.status === 422;
      }, 60_000, 5000);
      const okEmail = `s19a-ok-${nonce()}@example.com`;
      const okPw = strongPw();
      const strong = await signup({ email: okEmail, password: okPw });
      remember(strong);
      out.push({
        id: "S19a",
        title: "HIBP at signup: a breached password is refused, a strong one accepted",
        status: breached.status === 422 && strong.status === 200 ? "pass" : "fail",
        detail: `PATCH hibp+autoconfirm -> ${p1.status}; signup with a breached password -> ${breached.status} ${errCode(breached.json, breached.text)} (enforced after ${enforced.elapsedS}s); strong password -> ${strong.status}. HIBP is enforced at signup (S11: not on PUT /auth/v1/user).`,
        measurements: { breached_status: breached.status, breached_code: errCode(breached.json, breached.text).slice(0, 40), strong_status: strong.status, enforced_after_s: enforced.elapsedS },
      });

      // S19b - anonymous sign-in rate limit driven to 429
      const p2 = await patch({ external_anonymous_users_enabled: true, rate_limit_anonymous_users: 3 });
      await waitFor(async () => {
        const g = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
        return Number((g.json as Record<string, unknown> | undefined)?.rate_limit_anonymous_users) === 3;
      }, 30_000, 5000);
      await new Promise((r) => setTimeout(r, 15_000));
      const statuses: number[] = [];
      let first429 = -1;
      let body429 = "";
      for (let i = 0; i < 15; i++) {
        const r = await signup({ data: {} });
        statuses.push(r.status);
        if (r.status === 200) remember(r);
        if (r.status === 429 && first429 < 0) { first429 = i + 1; body429 = errCode(r.json, r.text); }
      }
      const ok = statuses.filter((s) => s === 200).length;
      out.push({
        id: "S19b",
        title: "anonymous sign-in rate limit (set to 3/hour) reaches a 429",
        status: first429 > 0 ? "pass" : "fail",
        detail: `PATCH -> ${p2.status}; 15 anonymous sign-ins: ${ok} x 200, ${statuses.filter((s) => s === 429).length} x 429, first 429 at request #${first429 > 0 ? first429 : "none"}; 429 body: ${body429 || "-"}. Statuses: ${statuses.join(",")}.`,
        measurements: { limit_set: 3, ok_count: ok, first_429_at: first429, code_429: body429.slice(0, 60) },
      });
      await patch({ external_anonymous_users_enabled: Boolean(base.external_anonymous_users_enabled) });

      // S19c - CAPTCHA gate with Turnstile test secrets
      const p3 = await patch({ security_captcha_enabled: true, security_captcha_provider: "turnstile", security_captcha_secret: TURNSTILE_FAIL });
      let noTok = await signup({ email: `s19c-${nonce()}@example.com`, password: strongPw() });
      remember(noTok);
      const gated = await waitFor(async () => {
        if (noTok.status !== 200) return true;
        noTok = await signup({ email: `s19c-${nonce()}@example.com`, password: strongPw() });
        remember(noTok);
        return noTok.status !== 200;
      }, 60_000, 5000);
      const loginNoTok = await login(okEmail, okPw);
      const withTokFail = await signup({ email: `s19c-${nonce()}@example.com`, password: strongPw(), gotrue_meta_security: { captcha_token: DUMMY_TOKEN } });
      remember(withTokFail);
      await patch({ security_captcha_secret: TURNSTILE_PASS });
      let withTokPass = await signup({ email: `s19c-${nonce()}@example.com`, password: strongPw(), gotrue_meta_security: { captcha_token: DUMMY_TOKEN } });
      remember(withTokPass);
      await waitFor(async () => {
        if (withTokPass.status === 200) return true;
        withTokPass = await signup({ email: `s19c-${nonce()}@example.com`, password: strongPw(), gotrue_meta_security: { captcha_token: DUMMY_TOKEN } });
        remember(withTokPass);
        return withTokPass.status === 200;
      }, 60_000, 5000);
      out.push({
        id: "S19c",
        title: "CAPTCHA gates signup and password login at the door (Turnstile test secrets)",
        status: noTok.status !== 200 && loginNoTok.status !== 200 && withTokFail.status !== 200 && withTokPass.status === 200 ? "pass" : "fail",
        detail: `PATCH turnstile always-fail -> ${p3.status}; gated after ${gated.elapsedS}s. No token: signup -> ${noTok.status} ${errCode(noTok.json, noTok.text)}; password login -> ${loginNoTok.status} ${errCode(loginNoTok.json, loginNoTok.text)}. Dummy token under always-fail -> ${withTokFail.status}. Always-pass secret + dummy token -> ${withTokPass.status}.`,
        measurements: { signup_no_token: noTok.status, login_no_token: loginNoTok.status, signup_token_failsecret: withTokFail.status, signup_token_passsecret: withTokPass.status, captcha_code: errCode(noTok.json, noTok.text).slice(0, 60) },
      });
      await patch({ security_captcha_enabled: false });

      // S19d - before-user-created hook as a Postgres function
      await sql(ctx, `
create or replace function public.sec19_hook(event jsonb) returns jsonb language plpgsql as $$
declare email text := event->'user'->>'email';
begin
  if email ilike '%@mailinator.com' then
    return jsonb_build_object('error', jsonb_build_object('http_code', 400, 'message', 'disposable email domains are not allowed'));
  end if;
  return '{}'::jsonb;
end$$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.sec19_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.sec19_hook(jsonb) from anon, authenticated, public;
`);
      const p4 = await patch({ hook_before_user_created_enabled: true, hook_before_user_created_uri: "pg-functions://postgres/public/sec19_hook" });
      hookInstalled = p4.status < 300;
      let blocked = await signup({ email: `s19d-${nonce()}@mailinator.com`, password: strongPw() });
      remember(blocked);
      // Active means the HOOK's message came back, not any 400: GoTrue answers
      // a generic 400 for a few seconds while it reloads the hook config.
      const isHookReject = (r: { status: number; json: unknown; text: string }) => r.status === 400 && /disposable/i.test(errCode(r.json, r.text));
      const hooked = await waitFor(async () => {
        if (isHookReject(blocked)) return true;
        blocked = await signup({ email: `s19d-${nonce()}@mailinator.com`, password: strongPw() });
        remember(blocked);
        return isHookReject(blocked);
      }, 90_000, 5000);
      let allowed = await signup({ email: `s19d-${nonce()}@example.com`, password: strongPw() });
      remember(allowed);
      await waitFor(async () => {
        if (allowed.status === 200) return true;
        allowed = await signup({ email: `s19d-${nonce()}@example.com`, password: strongPw() });
        remember(allowed);
        return allowed.status === 200;
      }, 60_000, 5000);
      out.push({
        id: "S19d",
        title: "before-user-created hook (Postgres function) rejects a disposable domain",
        status: isHookReject(blocked) && allowed.status === 200 ? "pass" : "fail",
        detail: `PATCH hook pg-functions://postgres/public/sec19_hook -> ${p4.status}; active after ${hooked.elapsedS}s. Blocked domain -> ${blocked.status} "${errCode(blocked.json, blocked.text)}"; allowed domain -> ${allowed.status}. The hook is where a domain allowlist lives, before the row exists.`,
        measurements: { hook_patch_status: p4.status, blocked_status: blocked.status, blocked_message: errCode(blocked.json, blocked.text).slice(0, 60), allowed_status: allowed.status, active_after_s: hooked.elapsedS },
      });
    } catch (e) {
      out.push({ id: "S19err", title: "S19 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      const restore: Record<string, unknown> = {};
      for (const k of RESTORE) if (k in base) restore[k] = base[k];
      restore.security_captcha_enabled = false;
      restore.hook_before_user_created_enabled = false;
      if (!restore.hook_before_user_created_uri) delete restore.hook_before_user_created_uri;
      const back = await patch(restore).catch(() => ({ status: 0 }));
      if (hookInstalled) await sql(ctx, `drop function if exists public.sec19_hook(jsonb);`).catch(() => {});
      let deleted = 0;
      for (const id of users) {
        const d = await httpBody(`https://${ctx.apiHost}/auth/v1/admin/users/${id}`, { method: "DELETE", key: keys.serviceJwt });
        if (d.status < 300) deleted++;
      }
      out.push({ id: "S19z", title: "restore auth config, drop hook, delete users", status: back.status < 300 ? "pass" : "fail", detail: `restore PATCH -> ${back.status}; ${deleted}/${users.length} users deleted`, measurements: { users_created: users.length, users_deleted: deleted } });
    }
    return out;
  },
};
export default mod;
