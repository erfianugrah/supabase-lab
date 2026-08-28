/**
 * L22 - Edge Functions under network restrictions.
 *
 * Claimed side effect (support answer, never measured here): with network
 * restrictions applied, Edge Functions lose direct database access and the
 * docs point at supabase-js over HTTP instead - which puts that traffic
 * back on the HTTP surface being locked down.
 *
 * Measure:
 *
 *   L22a - deploy an EF holding a direct postgres connection (deno
 *          postgres driver against db.<ref>.supabase.co or the pooler
 *          host), verify it works with no restrictions.
 *   L22b - apply restrict-all (supabase_settings.network via the supabase
 *          TF provider, verified shape in privatelink-aws) and re-invoke:
 *          record the failure mode verbatim (timeout? refusal? allowlist
 *          error naming the address?).
 *   L22c - the documented fallback: same EF rewritten to call
 *          /rest/v1 via supabase-js with the service key. Confirm it works
 *          under restrict-all - and record that the data now transits the
 *          public HTTP tier, i.e. the restriction pushed EF traffic onto
 *          the surface the customer wants closed.
 *
 * DESTRUCTIVE: applies network restrictions; removes them in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L22",
  title: "Edge Functions under restrict-all: direct DB failure mode + HTTP fallback",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L22",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Restriction shape: supabase_settings.network (privatelink-aws T12).",
    };
  },
};
export default mod;
