/**
 * L04 - Auth surface knobs.
 *
 * Which GoTrue levers the Management API exposes on this plan tier and what
 * each one leaves issuable. PATCH /v1/projects/{ref}/config/auth with:
 *
 *   - disable_signup: true        (signup refused, existing-user login still works?)
 *   - mailer_autoconfirm / external_email_enabled: false
 *   - external_anonymous_users_enabled: false
 *   - external_phone_enabled: false
 *
 * Measure per lever: the inventory's auth_signup row (malformed-email probe:
 * a live endpoint answers an address-validation error, a disabled one answers
 * signup_disabled regardless of the address) and auth_login row (the L01 user
 * must still log in - disable_signup closing LOGIN would be a finding).
 *
 * Also GET the auth config first and record which SSO/SAML fields exist on
 * this plan tier as info (Pro org - SAML is plan-gated; record the gate
 * verbatim if refused).
 *
 * DESTRUCTIVE: PATCHes auth config; restores the baseline object in finally.
 * GET the whole config first and PATCH back the exact baseline - hand-picking
 * fields to restore is how lossy round-trips get missed (T22 run-2 lesson).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L04",
  title: "Auth surface knobs: signup/provider disables, what remains issuable",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L04",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Lever: PATCH /v1/projects/{ref}/config/auth. Probe rows already in lib/inventory.ts (auth_signup, auth_login).",
    };
  },
};
export default mod;
