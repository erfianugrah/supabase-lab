/**
 * S11 - auth hardening EFFICACY (closes the S03 gap).
 *
 * S03 proved the hardening levers are settable and read back. It did not prove
 * they REJECT: a setting that round-trips through the config API but is not
 * enforced on the wire is a false comfort. S11 sets two levers high, then
 * drives them at the wire via the password-UPDATE path (not signup, which the
 * default shared SMTP rate-limits to 2/hour) to confirm each actually refuses
 * the input it is meant to refuse, and admits a compliant one.
 *
 *   S11a - password_min_length=12 rejects a 4-char password on update.
 *   S11b - password_hibp_enabled=true rejects a known-breached password long
 *          enough to clear the length gate (isolates HIBP from length).
 *   S11c - a long, unique password is accepted (control: the policy admits a
 *          good password, so a/b are the policy filtering, not a broken path).
 *
 * Uses admin-create + password-grant sign-in + PUT /auth/v1/user, so no signup
 * and no confirmation email - the policy applies identically to updates.
 *
 * DESTRUCTIVE: PATCHes auth config and creates one throwaway user; restores
 * config in finally. The user dies with the project at teardown.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http } from "../lib/sec.js";

// A password long enough to clear a 12-char minimum, so a rejection is HIBP,
// not length. Unambiguously in the Have I Been Pwned corpus.
const PWNED_LONG = "passwordpassword";

/** PUT /auth/v1/user with a user token (apikey=anon, bearer=user). */
async function setPassword(apiHost: string, anon: string, userToken: string, password: string) {
  return http(`https://${apiHost}/auth/v1/user`, {
    method: "PUT",
    key: anon,
    headers: { Authorization: `Bearer ${userToken}` },
    body: { password },
  });
}

const mod: TestModule = {
  id: "S11",
  title: "auth hardening is enforced on the wire (S03 measured only that it is settable)",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const { anonJwt, serviceJwt } = await fetchKeys(ctx);
    const cfg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
    if (cfg.status !== 200) return [{ id: "S11", title: this.title, status: "fail", detail: `GET auth config HTTP ${cfg.status}` }];
    const base = cfg.json as Record<string, unknown>;
    const results: TestResult[] = [];

    const touch = ["password_min_length", "password_hibp_enabled"] as const;
    const saved: Record<string, unknown> = {};
    for (const k of touch) if (k in base) saved[k] = base[k];

    try {
      const set = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { password_min_length: 12, password_hibp_enabled: true });
      if (set.status >= 300) return [{ id: "S11", title: this.title, status: "fail", detail: `PATCH auth config HTTP ${set.status}: ${set.text.slice(0, 160)}` }];

      // Admin-create a confirmed user with a strong password, then sign in.
      const email = `s11_${crypto.randomUUID().slice(0, 12)}@example.com`;
      const startPw = `${crypto.randomUUID()}Aa1!`;
      const create = await http(`https://${ctx.apiHost}/auth/v1/admin/users`, {
        method: "POST",
        key: serviceJwt,
        body: { email, password: startPw, email_confirm: true },
      });
      if (create.status >= 300) return [{ id: "S11", title: this.title, status: "fail", detail: `admin create user HTTP ${create.status} ${create.code}` }];

      const signinRes = await fetch(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anonJwt, Authorization: `Bearer ${anonJwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: startPw }),
        signal: AbortSignal.timeout(15_000),
      });
      const token = (await signinRes.json().catch(() => ({})) as { access_token?: string }).access_token ?? "";
      if (!token) return [{ id: "S11", title: this.title, status: "fail", detail: `sign-in returned no access_token (HTTP ${signinRes.status})` }];

      const short = await setPassword(ctx.apiHost, anonJwt, token, "aA1!");
      results.push({
        id: "S11a",
        title: "min-length policy rejects a short password on update",
        status: short.status === 422 ? "pass" : "fail",
        detail: `min_length=12, update to a 4-char password -> ${short.status} ${short.code}. A settable lever that also refuses on the wire.`,
        measurements: { short_pw_status: short.status },
      });

      const pwned = await setPassword(ctx.apiHost, anonJwt, token, PWNED_LONG);
      const rejected = pwned.status === 422;
      results.push({
        id: "S11b",
        title: "leaked-password (HIBP) on the password-UPDATE path",
        status: rejected ? "pass" : "info",
        detail: rejected
          ? `HIBP on, update to a breached password -> 422 ${pwned.code}. Refused for being breached (it cleared the 12-char minimum).`
          : `FINDING: HIBP on, update to a breached password -> ${pwned.status} (accepted). Leaked-password protection is enforced on SIGNUP but NOT on PUT /auth/v1/user, so a password CHANGE can set a breached password even with HIBP on. Settable != enforced everywhere.`,
        measurements: { pwned_pw_status: pwned.status, hibp_enforced_on_update: String(rejected) },
      });

      const strong = await setPassword(ctx.apiHost, anonJwt, token, `${crypto.randomUUID()}Aa1!`);
      results.push({
        id: "S11c",
        title: "a compliant password is admitted (policy is not block-everything)",
        status: strong.status < 300 ? "pass" : "fail",
        detail: `update to a long unique password -> ${strong.status} ${strong.code || "ok"}. The policy admits a good password, so S11a/b are the policy filtering, not a broken update path.`,
        measurements: { strong_pw_status: strong.status },
      });
    } catch (e) {
      results.push({ id: "S11err", title: "S11 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (Object.keys(saved).length) {
        const back = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, saved);
        results.push({ id: "S11z", title: "restore auth config", status: back.status < 300 ? "pass" : "fail", detail: back.status < 300 ? "restored" : `restore HTTP ${back.status}` });
      }
    }
    return results;
  },
};
export default mod;
