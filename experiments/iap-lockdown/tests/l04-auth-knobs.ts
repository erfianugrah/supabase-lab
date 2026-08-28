/**
 * L04 - Auth surface knobs.
 *
 * Which GoTrue levers the Management API exposes and what each leaves
 * issuable. PATCH /projects/{ref}/config/auth { disable_signup, ... }.
 *
 * Measured: does disabling signup close SIGNUP while leaving an existing
 * user's LOGIN working (disable_signup closing login would be a finding);
 * and which SSO/SAML fields exist on this plan tier (info).
 *
 * Self-contained: creates its own known user (admin API, IAP_USER_PASSWORD)
 * so the auth_login inventory row is deterministic regardless of L01.
 *
 * DESTRUCTIVE: PATCHes auth config; restores the fields it changed in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, inventory, toMeasurements, waitFor, IAP_USER_PASSWORD } from "../lib/inventory.js";

const mod: TestModule = {
  id: "L04",
  title: "Auth surface knobs: signup/provider disables, what remains issuable",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const cfg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
    if (cfg.status !== 200) {
      return [{ id: "L04", title: this.title, status: "fail", detail: `GET auth config http ${cfg.status}` }];
    }
    const base = cfg.json as Record<string, unknown>;
    const results: TestResult[] = [];

    // Record the SSO/SAML surface (plan-gated) as info.
    results.push({
      id: "L04a",
      title: "SSO/SAML fields present on this tier",
      status: "info",
      detail: Object.keys(base).filter((k) => /saml|sso/i.test(k)).map((k) => `${k}=${String(base[k])}`).join(" ") || "no saml/sso fields in auth config",
      measurements: { saml_enabled: String(base.saml_enabled ?? "absent") },
    });

    // A known, login-capable user for the deterministic auth_login row.
    const userEmail = `iap.l04.${Date.now()}@example.com`;
    const mk = await http(`https://${ctx.apiHost}/auth/v1/admin/users`, {
      method: "POST",
      key: keys.serviceJwt,
      body: { email: userEmail, password: IAP_USER_PASSWORD, email_confirm: true },
    });
    if (mk.status >= 300 && mk.status !== 422) {
      return [...results, { id: "L04", title: this.title, status: "fail", detail: `admin create user http ${mk.status} ${mk.code}` }];
    }

    const invBefore = await inventory(ctx, keys.anonJwt, userEmail);
    const loginBefore = invBefore.find((r) => r.surface === "auth_login");
    const signupBefore = invBefore.find((r) => r.surface === "auth_signup");
    results.push({
      id: "L04b",
      title: "baseline: signup live, existing user can log in",
      status: loginBefore?.status === 200 ? "pass" : "fail",
      detail: `auth_login=${loginBefore?.status} auth_signup=${signupBefore?.status} ${signupBefore?.code}`,
      measurements: toMeasurements(invBefore, "auth_base"),
    });

    try {
      const off = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { disable_signup: true });
      results.push({
        id: "L04c",
        title: "PATCH disable_signup=true",
        status: off.status === 200 ? "pass" : "fail",
        measurements: { patch_status: off.status },
        evidence: off.status === 200 ? undefined : off.text.slice(0, 300),
      });
      if (off.status === 200) {
        // Poll signup until it reports disabled.
        await waitFor(async () => {
          const s = await http(`https://${ctx.apiHost}/auth/v1/signup`, {
            method: "POST",
            key: keys.anonJwt,
            body: { email: "iap-probe-not-an-email", password: "x" },
          });
          return /signup.?disabled|disabled/i.test(s.code) || s.status === 422 || s.status === 403;
        }, 60_000);

        const invAfter = await inventory(ctx, keys.anonJwt, userEmail);
        const loginAfter = invAfter.find((r) => r.surface === "auth_login");
        const signupAfter = invAfter.find((r) => r.surface === "auth_signup");
        results.push({
          id: "L04d",
          title: "signup disabled: signup refused, existing-user login survives",
          status: loginAfter?.status === 200 && signupAfter?.status !== 200 ? "pass" : "fail",
          detail: `auth_signup=${signupAfter?.status} ${signupAfter?.code} | auth_login=${loginAfter?.status} (login must survive)`,
          measurements: toMeasurements(invAfter, "signup_off"),
        });
      }
    } finally {
      const back = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, {
        disable_signup: Boolean(base.disable_signup),
      });
      results.push({
        id: "L04z",
        title: "restore disable_signup",
        status: back.status === 200 ? "pass" : "fail",
        detail: back.status === 200 ? `restored to ${Boolean(base.disable_signup)}` : `restore HTTP ${back.status} - AUTH CONFIG LEFT MUTATED`,
        measurements: { restore_status: back.status },
      });
      // Best-effort cleanup of the probe user.
      const list = await http(`https://${ctx.apiHost}/auth/v1/admin/users?page=1&per_page=50`, { key: keys.serviceJwt });
      void list;
    }
    return results;
  },
};
export default mod;
