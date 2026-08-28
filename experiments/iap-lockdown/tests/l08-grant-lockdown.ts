/**
 * L08 - grant-based lockdown: the no-RLS-migration alternative.
 *
 * For a customer whose pen test found exposed data and who refuses a full
 * RLS migration, the grant layer is the cheap close. Each claim is one SQL
 * statement via the management query endpoint, measured through the Data API:
 *
 *   L08a - REVOKE SELECT ON public.iap_probe FROM anon, authenticated:
 *          anon Data-API read goes 42501-shaped; service_role keeps reading
 *          unchanged (service_role bypasses RLS AND holds the grant).
 *   L08b - the reopen path: pg_default_acl grants SELECT on NEW tables to
 *          anon/authenticated/service_role out of the box. Create a table
 *          AFTER the L08a revoke -> anon reads it fine. That is how a
 *          grant-lockdown silently rots: every migration reopens it.
 *   L08c - ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES
 *          FROM anon, authenticated (for BOTH grantor roles - postgres and
 *          supabase_admin carry separate default ACLs; check
 *          pg_default_acl before and after). New table now closed on arrival.
 *   L08d - the pen-test shape: RLS enabled on a table, a plain VIEW over it
 *          returns every row to anon (owner bypass), while the same view
 *          WITH (security_invoker = true) returns 0 rows. Views are the
 *          classic "we have RLS, why is it exposed" hole.
 *   L08e - function surface: default privileges also grant EXECUTE on new
 *          functions in public to anon/authenticated. A bare function with
 *          no auth check is callable through /rest/v1/rpc/ the moment it is
 *          created. Measure, revoke, re-measure.
 *
 * All statements run as the postgres role through POST /database/query.
 * Fixture objects live in a dedicated schema (iap_l08) dropped in finally so
 * the module cannot contaminate the shared public-schema fixture.
 *
 * DESTRUCTIVE: mutates grants + default privileges on the project; restores
 * (re-grant + reset default privileges) in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L08",
  title: "grant-based lockdown: revoke, default-privileges reopen, security_invoker views, RPC defaults",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L08",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. All SQL via POST /v1/projects/{ref}/database/query; API probes via lib/inventory.ts http().",
    };
  },
};
export default mod;
