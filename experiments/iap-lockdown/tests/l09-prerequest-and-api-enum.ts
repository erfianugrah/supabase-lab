/**
 * L09 - pre-request-hook reachability + whole-spec enumeration for
 * network/security levers.
 *
 * Two halves:
 *
 *   L09a - The hook question, measured to the limit of what a lab can know.
 *          A claim exists that a Postgres-side pre-request function can
 *          reject PostgREST calls on request headers (an IP allowlist at
 *          the DB layer). What the lab CAN measure:
 *            - whether current_setting('request.headers', true) returns
 *              anything in SQL on a managed project (via /database/query -
 *              note: that endpoint is NOT PostgREST, so it cannot prove the
 *              GUC exists on the PostgREST path; a NULL here is a limit of
 *              the probe, not a negative);
 *            - whether any published /v1 Management API operation configures
 *              such a hook (the enumeration below).
 *          What the lab CANNOT measure, and the module must say so: whether
 *          the edge overwrites or appends a client-supplied forwarding
 *          header before PostgREST sees it. If it appends, any header-based
 *          check is spoofable and is not an allowlist. That is platform
 *          internals; record the question, do not answer it.
 *
 *   L09b - F05-method spec enumeration: fetch the published OpenAPI document
 *          (GET https://api.supabase.com/api/v1-json or the docs-erfi mirror
 *          of the spec; platform-facts F05 shows the pattern) and enumerate
 *          EVERY operation whose path/summary mentions network, restriction,
 *          allowlist, ip, waf, firewall, private, egress, or security. The
 *          deliverable is a complete list of what the control plane exposes
 *          for access restriction - so "there is no IP allowlist for the
 *          Data API" is stated across the whole spec, not inferred from a
 *          few probed paths (F05's name-guessing lesson).
 *
 * Read-only (the SQL probe is a SELECT; the enumeration is a GET), but left
 * destructive=false so it runs in the read-only tier.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L09",
  title: "pre-request hook reachability + full-spec network/security lever enumeration",
  where: "local",
  requires: ["pat"],
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L09",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Spec-enumeration pattern: platform-facts F05.",
    };
  },
};
export default mod;
