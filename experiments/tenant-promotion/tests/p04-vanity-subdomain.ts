/**
 * P04 - can you hide the project ref behind a vanity subdomain?
 *
 * The dedicated project's public hostname (<ref>.supabase.co) is visible in
 * every API call. The Management API exposes a vanity-subdomain endpoint that
 * would let a tenant customise it, but whether it is available on a
 * non-Enterprise plan is an open question. Probe both check-availability and
 * activate, recording the outcome. A refusal is a measured result, never a
 * thrown error.
 *
 * Note: check-availability answers 201 (not 200) on success, per prior live
 * observation. A hand-rolled predecessor read that as a refusal and skipped
 * the activate call, which is why this test exists.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const mod: TestModule = {
  id: "P04",
  title: "Vanity subdomain: can the ref be hidden without a proxy?",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // probes Management API endpoints that may mutate state
  async run(ctx) {
    const dedicated = ctx.peers.dedicated;
    if (!dedicated) {
      return {
        id: "P04",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_DEDICATED not set - this experiment needs two projects",
      };
    }
    const results: TestResult[] = [];

    // A bare label, not a hostname: the endpoint owns the .supabase.co
    // suffix, and a dotted value is rejected with 400 before availability
    // is ever evaluated. Randomised because the namespace is global.
    const domain = `lab-promo-${Math.random().toString(36).slice(2, 8)}`;

    // ---- check-availability ----
    const check = await mgmt(
      ctx,
      "POST",
      `/projects/${dedicated}/vanity-subdomain/check-availability`,
      { vanity_subdomain: domain },
    );
    results.push({
      id: "P04a",
      title: "vanity-subdomain check-availability",
      status: check.status < 300 ? "pass" : "info",
      detail: `HTTP ${check.status} for "${domain}"${check.throttled ? " (throttled)" : ""}`,
      measurements: { status: check.status },
      evidence: check.text.slice(0, 300),
    });

    // ---- activate (only if check succeeded) ----
    if (check.status < 300) {
      const activate = await mgmt(
        ctx,
        "POST",
        `/projects/${dedicated}/vanity-subdomain/activate`,
        { vanity_subdomain: domain },
      );
      const ok = activate.status < 300;
      results.push({
        id: "P04b",
        title: "vanity-subdomain activate",
        status: ok ? "pass" : "info",
        detail: ok
          ? `HTTP ${activate.status} - activate succeeded`
          : `HTTP ${activate.status} - activate refused${activate.throttled ? " (throttled)" : ""}`,
        measurements: { status: activate.status },
        evidence: activate.text.slice(0, 300),
      });
    } else {
      results.push({
        id: "P04b",
        title: "vanity-subdomain activate (not attempted)",
        status: "info",
        detail: `check-availability returned ${check.status} - activate skipped`,
        measurements: { status: check.status },
      });
    }

    return results;
  },
};
export default mod;