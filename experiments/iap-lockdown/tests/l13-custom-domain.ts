/**
 * L13 - custom domain: the CNAME misconception, measured.
 *
 * The customer's only UI find was the custom-domain CNAME, read as an
 * access-control lever. It is a branding add-on. Measure:
 *
 *   L13a - activate a custom domain on the project (vanity hostname under
 *          the lab's zone; tenant-promotion measured the vanity-subdomain
 *          API: check-availability answers 201, wants a bare LABEL).
 *   L13b - the origin hostname keeps serving: <ref>.supabase.co answers
 *          identically before and after activation, with both key classes.
 *          THIS is the row the whole misconception turns on.
 *   L13c - what activation actually changes: response headers, cert SANs on
 *          the custom hostname, and whether requests to the custom hostname
 *          carry any marker the origin could restrict on (they do not -
 *          record what IS observable).
 *   L13d - attempt to put CF proxying in front of the custom hostname and
 *          record cert/verification behaviour (the customer's instinct,
 *          tested).
 *
 * DESTRUCTIVE: activates/deactivates a custom domain; deactivates in
 * finally. Needs a lab-controlled zone + the vanity API surface; self-skips
 * without PVLAB_ENDPOINT_CUSTOM_DOMAIN_HOST set by the Makefile.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L13",
  title: "custom domain: origin hostname keeps serving; CNAME gates nothing",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L13",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Vanity-subdomain pattern: tenant-promotion.",
    };
  },
};
export default mod;
