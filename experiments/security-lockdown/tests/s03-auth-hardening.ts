/**
 * S03 - auth hardening levers.
 *
 * Which GoTrue hardening controls the Management API exposes and what each
 * closes: leaked-password protection (HIBP), MFA, password policy/length,
 * reauth-on-password-change, and the auth rate limits. GET the config,
 * inventory the hardening fields present, toggle the confirmable ones, and
 * record. Restore the changed fields in finally.
 *
 * DESTRUCTIVE: PATCHes auth config; restores changed fields.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const HARDENING = [
  "password_min_length",
  "password_required_characters",
  "security_update_password_require_reauthentication",
  "password_hibp_enabled",
  "mfa_totp_enroll_enabled",
  "mfa_totp_verify_enabled",
  "rate_limit_token_refresh",
  "rate_limit_verify",
  "rate_limit_email_sent",
];

const mod: TestModule = {
  id: "S03",
  title: "auth hardening: which levers exist and what each closes",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const cfg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
    if (cfg.status !== 200) return [{ id: "S03", title: this.title, status: "fail", detail: `GET auth config HTTP ${cfg.status}` }];
    const base = cfg.json as Record<string, unknown>;
    const results: TestResult[] = [];

    const present = HARDENING.filter((k) => k in base).map((k) => `${k}=${String(base[k])}`);
    const absent = HARDENING.filter((k) => !(k in base));
    results.push({
      id: "S03a",
      title: "hardening levers exposed by the Management API",
      status: "info",
      detail: `present: ${present.join(", ") || "none"}${absent.length ? ` | absent: ${absent.join(", ")}` : ""}`,
      measurements: { hibp_present: String("password_hibp_enabled" in base), mfa_present: String("mfa_totp_enroll_enabled" in base) },
    });

    const changed: Record<string, unknown> = {};
    try {
      // Toggle the reliably-present, non-destructive ones and confirm.
      const desired: Record<string, unknown> = {};
      if ("password_min_length" in base) desired.password_min_length = Math.max(12, Number(base.password_min_length ?? 6));
      if ("password_hibp_enabled" in base) desired.password_hibp_enabled = true;
      if ("mfa_totp_verify_enabled" in base) desired.mfa_totp_verify_enabled = true;
      for (const k of Object.keys(desired)) changed[k] = base[k];

      if (Object.keys(desired).length) {
        const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, desired);
        const after = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
        const now = after.json as Record<string, unknown>;
        const applied = Object.entries(desired).filter(([k, v]) => String(now[k]) === String(v)).map(([k]) => k);
        results.push({
          id: "S03b",
          title: "hardening levers are settable and take effect",
          status: patch.status < 300 && applied.length === Object.keys(desired).length ? "pass" : "fail",
          detail: `PATCH ${patch.status}; applied: ${applied.join(", ")} of ${Object.keys(desired).join(", ")}`,
          measurements: { patch_status: patch.status, applied_count: applied.length },
        });
      } else {
        results.push({ id: "S03b", title: "hardening levers settable", status: "skip", detail: "none of the target levers present on this tier" });
      }
    } catch (e) {
      results.push({ id: "S03err", title: "S03 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (Object.keys(changed).length) {
        const back = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, changed);
        results.push({ id: "S03z", title: "restore auth config", status: back.status < 300 ? "pass" : "fail", detail: back.status < 300 ? "restored" : `restore HTTP ${back.status}` });
      }
    }
    return results;
  },
};
export default mod;
