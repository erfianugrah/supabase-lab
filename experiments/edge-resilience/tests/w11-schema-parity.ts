/**
 * W11 - schema parity diff (what table-data replication misses)
 *
 * Measures whether replication of table data (w05) also replicates
 * the accompanying schema objects (policies, functions, triggers, views).
 *
 * Steps:
 * 1. Primary only: Setup schema objects.
 * 2. Standby: Skip setup (it should be empty/missing to show the gap).
 * 3. Diff probe (both projects).
 * 4. Remediation: apply the same DDL to the standby.
 * 5. Re-run diff: Expect parity.
 * 6. Finally: Cleanup.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W11",
  title: "schema parity diff (what table-data replication misses)",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const dbPw = ctx.dbPassword;
    const measurements: Record<string, string | number> = {};

    if (!standby || !dbPw) {
      return {
        id: "W11",
        title: this.title,
        status: "skip",
        detail: `missing peer/dbPassword: standby=${standby ?? "absent"}, dbPassword=${dbPw ? "set" : "absent"}`,
      };
    }

    const runSql = async (ref: string, query: string) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    const diffProbe = async (
      ref: string,
    ): Promise<Record<"policies" | "procs" | "triggers" | "views", number>> => {
      const queries = {
        policies: `SELECT count(*) FROM pg_policies WHERE tablename = 'w11_t'`,
        procs: `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'public' AND p.proname LIKE 'w11%'`,
        triggers: `SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'w11%'`,
        views: `SELECT count(*) FROM pg_views WHERE viewname LIKE 'w11%'`,
      };
      const counts: Record<string, number> = {};
      for (const [key, query] of Object.entries(queries)) {
        const res = await runSql(ref, query);
        const data = (res.json as any[])?.[0];
        counts[key] = data ? Number(Object.values(data)[0]) : 0;
      }
      return counts;
    };

    const cleanup = async () => {
      const sqls = [
        `DROP VIEW IF EXISTS public.w11_v`,
        `DROP TRIGGER IF EXISTS w11_trig ON public.w11_t`,
        `DROP FUNCTION IF EXISTS public.w11_trig_fn()`,
        `DROP FUNCTION IF EXISTS public.w11_f()`,
        `DROP TABLE IF EXISTS public.w11_t`
      ];
      for (const sql of sqls) {
        await runSql(primary, sql).catch(() => {});
        await runSql(standby, sql).catch(() => {});
      }
    };

    try {
      // 1. Primary only: Setup schema objects.
      await runSql(primary, `
        DROP TABLE IF EXISTS public.w11_t;
        CREATE TABLE public.w11_t(id serial primary key, val text);
        ALTER TABLE public.w11_t ENABLE ROW LEVEL SECURITY;
        CREATE POLICY w11_p ON public.w11_t FOR SELECT TO authenticated USING (true);
        CREATE OR REPLACE FUNCTION public.w11_f() RETURNS int LANGUAGE sql AS 'select 1';
        CREATE OR REPLACE FUNCTION public.w11_trig_fn() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;';
        CREATE TRIGGER w11_trig AFTER INSERT ON public.w11_t FOR EACH ROW EXECUTE FUNCTION public.w11_trig_fn();
        CREATE OR REPLACE VIEW public.w11_v AS SELECT * FROM public.w11_t;
      `);
      measurements["primary_setup"] = "done";

      // 2. Standby: Skip setup (it should be empty/missing to show the gap).
      // We rely on cleanup() to ensure standby is clean.
      measurements["standby_setup"] = "skipped (using cleanup)";

      // 3. Diff probe (both projects).
      const primaryCounts = await diffProbe(primary);
      const standbyCounts = await diffProbe(standby);

      measurements["primary_policies"] = primaryCounts.policies;
      measurements["primary_procs"] = primaryCounts.procs;
      measurements["primary_triggers"] = primaryCounts.triggers;
      measurements["primary_views"] = primaryCounts.views;

      measurements["standby_policies"] = standbyCounts.policies;
      measurements["standby_procs"] = standbyCounts.procs;
      measurements["standby_triggers"] = standbyCounts.triggers;
      measurements["standby_views"] = standbyCounts.views;

      if (primaryCounts.policies !== 0 && standbyCounts.policies === 0) {
        // Gap detected.
        measurements["gap_detected"] = "true";
      } else {
        throw new Error(`Expected parity gap (primary > 0, standby = 0) not observed. Primary: ${JSON.stringify(primaryCounts)}, Standby: ${JSON.stringify(standbyCounts)}`);
      }

      // 4. Remediation: apply the same DDL to the standby.
      await runSql(standby, `
        DROP TABLE IF EXISTS public.w11_t;
        CREATE TABLE public.w11_t(id serial primary key, val text);
        ALTER TABLE public.w11_t ENABLE ROW LEVEL SECURITY;
        CREATE POLICY w11_p ON public.w11_t FOR SELECT TO authenticated USING (true);
        CREATE OR REPLACE FUNCTION public.w11_f() RETURNS int LANGUAGE sql AS 'select 1';
        CREATE OR REPLACE FUNCTION public.w11_trig_fn() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;';
        CREATE TRIGGER w11_trig AFTER INSERT ON public.w11_t FOR EACH ROW EXECUTE FUNCTION public.w11_trig_fn();
        CREATE OR REPLACE VIEW public.w11_v AS SELECT * FROM public.w11_t;
      `);
      measurements["remediation_applied"] = "true";

      // 5. Re-run diff.
      const standbyCountsPost = await diffProbe(standby);
      measurements["standby_policies_post"] = standbyCountsPost.policies;
      measurements["standby_procs_post"] = standbyCountsPost.procs;
      measurements["standby_triggers_post"] = standbyCountsPost.triggers;
      measurements["standby_views_post"] = standbyCountsPost.views;

      if (standbyCountsPost.policies === primaryCounts.policies &&
          standbyCountsPost.procs === primaryCounts.procs &&
          standbyCountsPost.triggers === primaryCounts.triggers &&
          standbyCountsPost.views === primaryCounts.views) {
        measurements["parity_achieved"] = "true";
      } else {
        throw new Error("Parity not achieved after remediation");
      }

      return {
        id: "W11",
        title: this.title,
        status: "pass",
        detail: "Schema parity gap measured and remediated",
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W11",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
	}
  },
};
export default mod;
