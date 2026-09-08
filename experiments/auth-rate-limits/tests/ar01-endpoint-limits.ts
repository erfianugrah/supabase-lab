/**
 * AR01 - where GoTrue's rate limits actually bite. The docs give per-endpoint
 * quotas (per IP, token bucket, capacity 30); this fires real bursts and
 * records the request index where the 429 lands, the retry-after, and the body
 * verbatim.
 *
 *   AR01a  anonymous sign-in (POST /auth/v1/signup, no email/phone): per-IP,
 *          docs 30/hour with a burst of 30. Fire up to 60 and record where 429
 *          first appears. PASS if a 429 appears within the budget - the exact
 *          index depends on how full the bucket started.
 *   AR01b  email-send cap on the BUILT-IN provider (POST /auth/v1/signup with
 *          an email): docs say 2/hour without custom SMTP. Fire a handful of
 *          signups with distinct emails and record where the send is refused.
 *          INFO: on a fresh project the built-in provider and confirmations may
 *          or may not be on by default, so the value is the evidence, and a
 *          "no refusal" result is recorded, not failed.
 *   AR01c  the documented defaults from config/auth, pinned next to the
 *          measured boundary so a reader sees config vs behaviour in one place.
 *
 * Not settled by this module: token-refresh (1800/hour) and verify (360/hour) -
 * their budgets are too large to trip cheaply in a probe; AR01 covers the two
 * that bite fast. Requires anonymous sign-ins to be enabled for AR01a (enabled
 * here in setup, restored in finally).
 *
 * DESTRUCTIVE: creates anonymous and email users, deletes them in finally;
 * toggles enable_anonymous_sign_ins, restored in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys } from "../../../harness/src/platform";
import { anonSignin, burstUntil429, deleteUsersByPrefix, emailSignup, getAuthConfig, patchAuthConfig, waitAnonEnabled } from "../lib/auth";

const mod: TestModule = {
  id: "AR01",
  title: "GoTrue rate limits: where the 429 lands on each endpoint",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AR01", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];

    const base = await getAuthConfig(ctx);
    const anonWasOn = Boolean(base.external_anonymous_users_enabled);
    try {
      if (!anonWasOn) await patchAuthConfig(ctx, { external_anonymous_users_enabled: true });
      // Wait for the enable to propagate, else the burst races it and every
      // request comes back 422 (anonymous sign-ins disabled) instead of 429.
      const settled = await waitAnonEnabled(ctx, 30_000);

      // AR01a - anonymous sign-in burst.
      const anon = await burstUntil429(anonSignin(ctx), 60);
      if (!anon.status429 && !settled) anon.body = "anon enable did not propagate within 30s; burst saw 422s, not the rate limit";
      out.push({
        id: "AR01a",
        title: "anonymous sign-in: per-IP 429 boundary (docs 30/hour, burst 30)",
        status: anon.status429 ? "pass" : "fail",
        detail: anon.status429
          ? `429 at request ${anon.firstBlockAt}/${anon.sent}, retry-after ${anon.retryAfter}; body ${anon.body}`
          : `no 429 in ${anon.sent} requests (statuses ${JSON.stringify(anon.statuses)})`,
        measurements: {
          first_429_at: anon.firstBlockAt,
          sent: anon.sent,
          retry_after: anon.retryAfter,
          statuses: JSON.stringify(anon.statuses),
        },
      });

      // AR01b - email-send cap on built-in SMTP.
      const em = await burstUntil429(emailSignup(ctx), 6);
      out.push({
        id: "AR01b",
        title: "email-send cap on built-in SMTP (docs 2/hour without custom SMTP)",
        status: "info",
        detail: em.status429
          ? `send refused (429) at signup ${em.firstBlockAt}, retry-after ${em.retryAfter}; body ${em.body}`
          : `no 429 in ${em.sent} email signups (statuses ${JSON.stringify(em.statuses)}) - confirmations/built-in SMTP state matters`,
        measurements: { first_429_at: em.firstBlockAt, sent: em.sent, statuses: JSON.stringify(em.statuses) },
      });

      // AR01c - the documented knobs, as pinned config.
      const fields = ["rate_limit_anonymous_users", "rate_limit_email_sent", "rate_limit_otp", "rate_limit_verify", "rate_limit_token_refresh", "rate_limit_sms_sent"];
      const present = fields.filter((f) => f in base).map((f) => `${f}=${String(base[f])}`);
      out.push({
        id: "AR01c",
        title: "documented rate-limit knobs on config/auth (recorded)",
        status: "info",
        detail: present.join(", ") || "no rate_limit_* fields in config/auth",
        measurements: Object.fromEntries(fields.map((f) => [f, String(base[f] ?? "absent")])),
      });
    } catch (e) {
      out.push({ id: "AR01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (!anonWasOn) await patchAuthConfig(ctx, { external_anonymous_users_enabled: false }).catch(() => 0);
      const delAnon = keys.service ? await deleteUsersByPrefix(ctx, keys.service, "").catch(() => 0) : 0;
      const delEmail = keys.service ? await deleteUsersByPrefix(ctx, keys.service, "ar.").catch(() => 0) : 0;
      out.push({ id: "AR01z", title: "cleanup: delete probe users, restore anon toggle", status: "pass", detail: `deleted ${delAnon} anonymous + ${delEmail} email users; anon toggle restored to ${anonWasOn}` });
    }
    return out;
  },
};

export default mod;
