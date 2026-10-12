/**
 * CK02 - Do sign-up, sign-in, refresh and the custom access token hook behave
 * the same on every target, and what do the refusals look like?
 *
 * SIDE: each target's Auth (GoTrue) through its gateway, with the target's
 * anon key as `apikey`; users created at setup through the admin API. Tokens
 * live 300 s on every target (jwt_exp / JWT_EXPIRY set at setup).
 *
 *   a  sign-up with password (autoconfirm on): 200 with a session; the token
 *      carries `tenant_ids` = [] (hook ran for a user with no membership)
 *   b  sign-in as the tenant owner: `tenant_ids` = [primary tenant]
 *   c  refresh: 200, new access token, hook claim still present
 *   d  wrong password: refused; shape recorded
 *   e  disabled user (admin ban_duration on the sign-up user): sign-in refused; shape
 *   f  expired token (viewer token minted at setup): GET /auth/v1/user and
 *      GET /rest/v1/records at exp + 5 s (statuses only: verifiers may allow
 *      clock-skew leeway) and at exp + 45 s (must be refused; shapes)
 *
 * Shapes are `status type keys code` (keys = sorted JSON body keys) so the
 * parity script can compare them field by field across targets.
 *
 * Not settled: MFA, OAuth providers, rate limits on sign-up.
 * DESTRUCTIVE: creates one user per target (left in place; the run's data is
 * thrown away with the stack or project). Waits up to ~5 min for (f).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { errMsg, http, jsonOr, jwtPayload, loadRun, loadState, row, scrub, shape, signIn, sleep, type HarnessTarget } from "../lib/ckrun";

const fmt = (s: ReturnType<typeof shape>) => `${s.status} ${s.type} ${s.keys} ${s.code}`;

async function authCall(t: HarnessTarget, method: string, path: string, body?: unknown, bearer?: string) {
  return http(`${t.client.url}/auth/v1${path}`, {
    method,
    headers: { apikey: t.client.anonKey, "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const mod: TestModule = {
  id: "CK02",
  title: "Auth flows, hook claim and refusal shapes",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK02", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    const pending: { t: HarnessTarget; m: Record<string, string | number>; problems: string[] }[] = [];
    for (const t of l.targets) {
      const st = loadState(l.run, t.name);
      const m: Record<string, string | number> = {};
      const problems: string[] = [];
      try {
        const email = `ck-signup-${Date.now()}@lab.test`;
        const pw = `${crypto.randomUUID()}Aa1`;
        const su = await authCall(t, "POST", "/signup", { email, password: pw });
        const sj = jsonOr(su.body) ?? {};
        const suToken = sj.access_token ?? sj.session?.access_token;
        m.a_signup_status = su.status;
        m.a_signup_session = suToken ? "yes" : "no";
        if (suToken) m.a_signup_tenant_ids = JSON.stringify(jwtPayload(suToken).tenant_ids ?? null);
        if (su.status !== 200 || !suToken || m.a_signup_tenant_ids !== "[]") problems.push("a");

        const si = await signIn(t, st.users.owner.email, st.users.owner.password);
        const claims = si.status === 200 ? jwtPayload(si.j.access_token) : {};
        m.b_signin_status = si.status;
        m.b_tenant_ids_match = JSON.stringify(claims.tenant_ids) === JSON.stringify([st.tenants.primary]) ? "yes" : `no (${JSON.stringify(claims.tenant_ids ?? null)})`;
        m.b_token_alg = String(JSON.parse(Buffer.from((si.j?.access_token ?? "e30.").split(".")[0], "base64url").toString() || "{}").alg ?? "");
        m.b_token_lifetime_s = Number(claims.exp) - Number(claims.iat);
        m.b_claim_keys = Object.keys(claims).sort().join(",");
        if (si.status !== 200 || m.b_tenant_ids_match !== "yes") problems.push("b");

        const rf = await authCall(t, "POST", "/token?grant_type=refresh_token", { refresh_token: si.j?.refresh_token });
        const rj = jsonOr(rf.body) ?? {};
        m.c_refresh_status = rf.status;
        m.c_refresh_new_token = rj.access_token && rj.access_token !== si.j?.access_token ? "yes" : "no";
        m.c_refresh_tenant_ids = rj.access_token ? JSON.stringify(jwtPayload(rj.access_token).tenant_ids ?? null) === JSON.stringify([st.tenants.primary]) ? "match" : "differs" : "-";
        if (rf.status !== 200 || m.c_refresh_tenant_ids !== "match") problems.push("c");

        const wp = await authCall(t, "POST", "/token?grant_type=password", { email: st.users.owner.email, password: "wrong-password-1" });
        m.d_wrong_password = fmt(shape(wp));
        if (wp.status < 400) problems.push("d");

        const uid = String(sj.user?.id ?? sj.id ?? "");
        const ban = await http(`${t.client.url}/auth/v1/admin/users/${uid}`, {
          method: "PUT",
          headers: { apikey: t.serviceKey, authorization: `Bearer ${t.serviceKey}`, "content-type": "application/json" },
          body: JSON.stringify({ ban_duration: "876000h" }),
        });
        m.e_ban_status = ban.status;
        const bs = await authCall(t, "POST", "/token?grant_type=password", { email, password: pw });
        m.e_disabled_user = fmt(shape(bs));
        if (bs.status < 400) problems.push("e");
      } catch (e) {
        problems.push(`threw: ${scrub(l, errMsg(e))}`);
      }
      pending.push({ t, m, problems });
    }
    // (f) once for all targets: the early tokens are probed 5 s after their
    // exp (info: verifiers may allow clock-skew leeway; PostgREST documents
    // 30 s) and again 45 s after it, where they must be refused.
    const latest = Math.max(...l.targets.map((t) => loadState(l.run, t.name).earlyToken?.exp ?? 0));
    const probe = async (t: HarnessTarget) => {
      const tok = loadState(l.run, t.name).earlyToken?.token ?? "";
      const u = await authCall(t, "GET", "/user", undefined, tok);
      const r = await http(`${t.client.url}/rest/v1/records?select=id`, { headers: { apikey: t.client.anonKey, authorization: `Bearer ${tok}`, "accept-profile": "app" } });
      return { u, r };
    };
    for (const [after, tag] of [
      [5, "f5"],
      [45, "f45"],
    ] as const) {
      const waitMs = (latest + after) * 1000 - Date.now();
      if (waitMs > 0) {
        ctx.log(`CK02: waiting ${Math.round(waitMs / 1000)} s (setup tokens exp + ${after} s)`);
        await sleep(waitMs);
      }
      for (const p of pending) {
        try {
          const { u, r } = await probe(p.t);
          if (tag === "f5") {
            p.m.f5_expired_auth_user_status = u.status;
            p.m.f5_expired_rest_status = r.status;
          } else {
            p.m.f_expired_auth_user = fmt(shape(u));
            p.m.f_expired_rest = fmt(shape(r));
            if (u.status < 400 || r.status < 400) p.problems.push("f");
          }
        } catch (e) {
          p.problems.push(`${tag} threw: ${scrub(l, errMsg(e))}`);
        }
      }
    }
    for (const p of pending) {
      const { t, m, problems } = p;
      out.push(row("CK02", t, "auth flows and refusal shapes", problems.length ? "fail" : "pass", problems.length ? `failed rows: ${problems.join(", ")}` : `sign-up/in/refresh ok, tenant_ids claim present, 4 refusals recorded`, m));
    }
    return out;
  },
};
export default mod;
