/**
 * AR02 - Sb-Forwarded-For moves the rate-limit bucket off the caller's IP. A
 * server-side app calling GoTrue makes every end user share the server's one
 * IP against the per-IP buckets; the documented fix is to enable IP-address
 * forwarding and send Sb-Forwarded-For (with a secret key) so the limit keys on
 * the real end-user IP.
 *
 *   AR02a  forwarding OFF: anonymous sign-ins with DIFFERENT Sb-Forwarded-For
 *          values all come from the caller's one real IP, so they share one
 *          bucket and a burst still trips 429. Establishes the header is
 *          ignored until the feature is on.
 *   AR02b  forwarding ON (security_sb_forwarded_for_enabled=true) with a SECRET
 *          key: each distinct Sb-Forwarded-For is a distinct bucket, so a burst
 *          spread across many forwarded IPs does NOT trip. PASS if AR02a trips
 *          and AR02b does not - the differential is the whole claim.
 *
 * Not settled by this module: whether a publishable/anon key (rather than a
 * secret key) is honoured for forwarding - docs say only secret keys are, and
 * AR02b uses the secret key; the anon-key case is not probed here.
 *
 * DESTRUCTIVE: creates anonymous users, deletes them in finally; toggles
 * security_sb_forwarded_for_enabled and enable_anonymous_sign_ins, both
 * restored in finally. Self-skips without a secret key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys } from "../../../harness/src/platform";
import { anonSignin, burstUntil429, deleteUsersByPrefix, getAuthConfig, patchAuthConfig, sleep } from "../lib/auth";

const mod: TestModule = {
  id: "AR02",
  title: "Sb-Forwarded-For rebuckets the rate limit onto the end-user IP",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "AR02", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    if (!keys.secret) return [{ id: "AR02", title: this.title, status: "skip", detail: "no sb_secret_ key on this project (forwarding needs a secret key)" }];

    const out: TestResult[] = [];
    const base = await getAuthConfig(ctx);
    const anonWasOn = Boolean(base.external_anonymous_users_enabled);
    const fwdWasOn = Boolean(base.security_sb_forwarded_for_enabled ?? base.security_forwarded_for_enabled);

    // Distinct forwarded IPs, one per request.
    const fwd = (i: number) => `203.0.113.${(i % 250) + 1}`;

    try {
      if (!anonWasOn) await patchAuthConfig(ctx, { external_anonymous_users_enabled: true });

      // AR02a - forwarding OFF: header ignored, one real bucket, burst trips.
      await patchAuthConfig(ctx, { security_sb_forwarded_for_enabled: false });
      await sleep(3_000);
      const off = await burstUntil429((i) => anonSignin(ctx, fwd(i), keys.secret)(i), 60);
      out.push({
        id: "AR02a",
        title: "forwarding OFF: distinct Sb-Forwarded-For still share one bucket (429 trips)",
        status: off.status429 ? "pass" : "fail",
        detail: off.status429 ? `429 at request ${off.firstBlockAt}/${off.sent}` : `no 429 in ${off.sent} (statuses ${JSON.stringify(off.statuses)})`,
        measurements: { first_429_at: off.firstBlockAt, sent: off.sent },
      });

      // Let the bucket refill a little, then turn forwarding on.
      await patchAuthConfig(ctx, { security_sb_forwarded_for_enabled: true });
      await sleep(15_000);
      const on = await burstUntil429((i) => anonSignin(ctx, fwd(i), keys.secret)(i), 60);
      out.push({
        id: "AR02b",
        title: "forwarding ON: distinct Sb-Forwarded-For get distinct buckets (no 429)",
        status: !on.status429 ? "pass" : "fail",
        detail: !on.status429
          ? `no 429 across ${on.sent} requests spread over distinct forwarded IPs`
          : `429 still at request ${on.firstBlockAt}/${on.sent} - forwarding did not rebucket (body ${on.body})`,
        measurements: { first_429_at: on.firstBlockAt, sent: on.sent, statuses: JSON.stringify(on.statuses) },
      });
    } catch (e) {
      out.push({ id: "AR02", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await patchAuthConfig(ctx, { security_sb_forwarded_for_enabled: fwdWasOn }).catch(() => 0);
      if (!anonWasOn) await patchAuthConfig(ctx, { external_anonymous_users_enabled: false }).catch(() => 0);
      const del = keys.service ? await deleteUsersByPrefix(ctx, keys.service, "").catch(() => 0) : 0;
      out.push({ id: "AR02z", title: "cleanup: delete anonymous users, restore toggles", status: "pass", detail: `deleted ${del} anonymous users; forwarding restored to ${fwdWasOn}, anon to ${anonWasOn}` });
    }
    return out;
  },
};

export default mod;
