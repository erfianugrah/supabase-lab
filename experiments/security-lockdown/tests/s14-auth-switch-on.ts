/**
 * S14 - the Auth levers a customer switches ON.
 *
 * S03/S11 probed Auth for what leaks (HIBP off by default, HIBP not enforced on
 * the password-UPDATE path, disable_signup leaving an existing login). The
 * lever table in the doc is framed the same way - what stays open. It never
 * covers what a customer can turn on to harden the Auth service itself:
 *
 *   - a before-user-created hook (reject a signup before the row exists),
 *   - CAPTCHA (hCaptcha / Turnstile) on the auth entry points,
 *   - the configurable auth rate limits (lower them from the defaults).
 *
 * These tighten one service (Auth), like every managed lever - none is a tier
 * gate. This module inventories which switch-on fields the Management API
 * exposes and proves one is settable end to end (a rate limit lowered and read
 * back), then restores. Enforcement of the hook and CAPTCHA needs a live hook
 * endpoint and a real provider secret, so those are inventoried, not driven.
 *
 * DESTRUCTIVE: PATCHes auth config (one rate limit); restores in finally.
 *
 * Refs: auth-hooks/before-user-created-hook, auth-captcha, auth/rate-limits.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

// Switch-on fields, by group. Names are probed for presence (the API surface
// shifts by tier and version), never assumed - same discipline as S03.
const HOOK = ["hook_before_user_created_enabled", "hook_before_user_created_uri", "hook_before_user_created_secrets"];
const CAPTCHA = ["security_captcha_enabled", "security_captcha_provider", "security_captcha_secret"];
const RATE = [
  "rate_limit_anonymous_users",
  "rate_limit_email_sent",
  "rate_limit_sms_sent",
  "rate_limit_otp",
  "rate_limit_verify",
  "rate_limit_token_refresh",
  "rate_limit_web3",
];

const mod: TestModule = {
  id: "S14",
  title: "auth switch-on levers: before-user-created hook, CAPTCHA, configurable rate limits",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const cfg = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
    if (cfg.status !== 200) return [{ id: "S14", title: this.title, status: "fail", detail: `GET auth config HTTP ${cfg.status}` }];
    const base = cfg.json as Record<string, unknown>;
    const results: TestResult[] = [];

    const present = (keys: string[]) => keys.filter((k) => k in base);
    for (const [name, keys] of [["before-user-created hook", HOOK], ["CAPTCHA", CAPTCHA], ["configurable rate limits", RATE]] as const) {
      const have = present(keys);
      results.push({
        id: `S14a-${name.split(" ")[0]}`,
        title: `switch-on lever exposed: ${name}`,
        status: have.length ? "info" : "info",
        detail: have.length ? `present: ${have.map((k) => `${k}=${String(base[k])}`).join(", ")}` : `absent on this tier: ${keys.join(", ")}`,
        measurements: { present_count: have.length },
      });
    }

    // Prove one switch-on lever is settable end to end: lower a rate limit and
    // read it back. A customer switching Auth from its defaults to something
    // tighter, which the "what stays open" table omits.
    const rateKey = RATE.find((k) => k in base);
    const changed: Record<string, unknown> = {};
    try {
      if (rateKey) {
        const original = Number(base[rateKey] ?? 0);
        const lowered = Math.max(1, Math.min(original || 10, 5));
        changed[rateKey] = base[rateKey];
        const patch = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, { [rateKey]: lowered });
        const after = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth`);
        const now = (after.json as Record<string, unknown>)[rateKey];
        results.push({
          id: "S14b",
          title: "a configurable rate limit is settable and reads back",
          status: patch.status < 300 && String(now) === String(lowered) ? "pass" : "fail",
          detail: `PATCH ${rateKey}: ${original} -> ${lowered} (HTTP ${patch.status}); read back ${String(now)}.`,
          measurements: { patch_status: patch.status, lowered_to: lowered },
        });
      } else {
        results.push({ id: "S14b", title: "a configurable rate limit is settable", status: "skip", detail: "no rate_limit_* field present on this tier" });
      }
    } catch (e) {
      results.push({ id: "S14err", title: "S14 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      if (Object.keys(changed).length) {
        const back = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/config/auth`, changed);
        results.push({ id: "S14z", title: "restore auth config", status: back.status < 300 ? "pass" : "fail", detail: back.status < 300 ? "restored" : `restore HTTP ${back.status}` });
      }
    }
    return results;
  },
};
export default mod;
