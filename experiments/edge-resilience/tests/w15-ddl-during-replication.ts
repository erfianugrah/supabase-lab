/**
 * W15 - DDL during live replication (destructive).
 *
 * Measures whether applying DDL to a primary table (adding a column)
 * breaks logical replication for existing and new rows while a
 * subscription is active.
 *
 * Steps (single-statement for CREATE SUBSCRIPTION;
 * disable -> slot_name=none -> drop -> drop publisher slot for cleanup):
 * 1. Establish replication of public.w_repl (copy_data=false, streaming=on).
 *    Canary row proves the subscription is live before DDL is applied.
 * 2. On the primary only: ALTER TABLE ... ADD COLUMN w15_extra text.
 *    Insert one row that sets w15_extra; insert one with w15_extra NULL.
 * 3. Observe the standby for 60s - record pg_stat_subscription +
 *    pg_subscription_rel snapshots and any verbatim error state.
 * 4. Recovery: apply the same ALTER on the standby; measure whether
 *    replication resumes and both rows arrive.
 * 5. Cleanup: disable -> slot_name=none -> drop subscription; drop
 *    publication; drop publisher slot; drop tables both sides.
 *
 * Pass criteria: every outcome recorded verbatim. Any measured behavior passes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W15",
  title: "DDL during live replication (destructive)",
  where: "local",
  requires: ["pat", "anon-key", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const standbyAnon = ctx.endpoints["standby_anon"];
    const dbPw = ctx.dbPassword;
    const measurements: Record<string, string | number> = {};

    if (!standby || !standbyAnon || !dbPw) {
      return {
        id: "W15",
        title: this.title,
        status: "skip",
        detail: `missing peer/endpoints: standby=${standby ?? "absent"}, standby_anon=${standbyAnon ? "set" : "absent"}, dbPassword=${dbPw ? "set" : "absent"}`,
      };
    }

    const runSql = async (ref: string, query: string) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    const cleanup = async () => {
      // disable -> slot_name=none -> drop subscription -> drop publisher slot
      await runSql(standby, `ALTER SUBSCRIPTION w15_sub DISABLE`).catch(() => {});
      await runSql(standby, `ALTER SUBSCRIPTION w15_sub SET (slot_name = NONE)`).catch(() => {});
      await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w15_sub`).catch(() => {});
      await runSql(
        primary,
        `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'w15_sub'`,
      ).catch(() => {});
      await runSql(primary, `DROP PUBLICATION IF EXISTS w15_pub`).catch(() => {});
      await runSql(primary, `DROP TABLE IF EXISTS public.w_repl`).catch(() => {});
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl`).catch(() => {});
    };

    try {
      // 1a. Primary: table + publication (THIS EXACT ORDER per SPEC).
      await runSql(primary, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text)`);
      await runSql(primary, `DROP PUBLICATION IF EXISTS w15_pub`);
      await runSql(primary, `CREATE PUBLICATION w15_pub FOR TABLE public.w_repl`);

      // 1b. Standby: same table DDL.
      await runSql(standby, `DROP TABLE IF EXISTS public.w_repl; CREATE TABLE public.w_repl(id serial primary key, val text)`);

      // 1c. Single-statement CREATE SUBSCRIPTION (mandatory - rejected inside a transaction).
      const directConn = `host=db.${primary}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;
      await runSql(
        standby,
        `CREATE SUBSCRIPTION w15_sub CONNECTION '${directConn}' PUBLICATION w15_pub WITH (copy_data = false, streaming = on)`,
      );
      measurements["subscription_created"] = "true";

      // 1d. CANARY: insert on primary, poll standby (rows written BEFORE the
      // subscription do not replicate - copy_data=false; only this row and
      // later rows will appear on the standby).
      const canaryVal = `canary-${Math.random().toString(36).slice(2, 8)}`;
      await runSql(primary, `INSERT INTO public.w_repl (val) VALUES ('${canaryVal}')`);
      const standbyHeaders = { apikey: standbyAnon, Authorization: `Bearer ${standbyAnon}` };
      const syncStart = Date.now();
      let canaryArrived = false;
      while (Date.now() - syncStart < 60_000) {
        const res = await fetch(
          `https://${standby}.supabase.co/rest/v1/w_repl?select=val&val=eq.${canaryVal}`,
          { headers: standbyHeaders, signal: AbortSignal.timeout(10_000) },
        ).catch(() => null as Response | null);
        if (res && res.ok) {
          const data = (await res.json()) as unknown[];
          if (data.length > 0) {
            canaryArrived = true;
            measurements["canary_synced_ms"] = Date.now() - syncStart;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!canaryArrived) {
        measurements["canary_synced_ms"] = -1;
      }

      // 2. DDL on the primary only: add column, then insert one row that uses
      // it and one that does not (NULL). This is the test of the stall
      // prediction - replication should break until the standby catches up.
      await runSql(primary, `ALTER TABLE public.w_repl ADD COLUMN w15_extra text`);
      const extraVal = `extra-${Math.random().toString(36).slice(2, 8)}`;
      await runSql(primary, `INSERT INTO public.w_repl (val, w15_extra) VALUES ('row_with_extra', '${extraVal}')`);
      await runSql(primary, `INSERT INTO public.w_repl (val, w15_extra) VALUES ('row_without_extra', NULL)`);
      measurements["ddl_applied_primary"] = "true";

      // 3. Observe the standby for 60s - record snapshots verbatim.
      const observeStart = Date.now();
      let newRowCount = 0;
      while (Date.now() - observeStart < 60_000) {
        const res = await fetch(
          `https://${standby}.supabase.co/rest/v1/w_repl?select=id,val`,
          { headers: standbyHeaders, signal: AbortSignal.timeout(10_000) },
        ).catch(() => null as Response | null);
        if (res && res.ok) {
          const data = (await res.json()) as Array<{ val: string }>;
          newRowCount = data.filter((r) => r.val !== canaryVal).length;
          if (newRowCount >= 2) break;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      measurements["rows_arrived_before_standby_ddl"] = newRowCount;
      measurements["stalled_before_standby_ddl"] = newRowCount < 2 ? "true" : "false";

      // pg_stat_subscription: subscriber side (standby).
      const subStatRes = await runSql(
        standby,
        `SELECT subname, pid, received_lsn, latest_end_lsn, last_msg_receipt_time FROM pg_stat_subscription WHERE subname = 'w15_sub'`,
      ).catch(() => null);
      if (subStatRes) {
        measurements["stat_subscription"] = JSON.stringify(subStatRes.json ?? subStatRes.text.slice(0, 200));
      }

      // pg_subscription_rel: subscriber side (standby).
      const subRelRes = await runSql(
        standby,
        `SELECT srrelid::regclass, srsubstate FROM pg_subscription_rel`,
      ).catch(() => null);
      if (subRelRes) {
        measurements["subscription_rel"] = JSON.stringify(subRelRes.json ?? subRelRes.text.slice(0, 200));
      }

      // 4. Recovery: apply the same ALTER on the standby, then poll for both rows.
      await runSql(standby, `ALTER TABLE public.w_repl ADD COLUMN w15_extra text`);
      const resumeStart = Date.now();
      let bothArrived = false;
      while (Date.now() - resumeStart < 60_000) {
        const res = await fetch(
          `https://${standby}.supabase.co/rest/v1/w_repl?select=id,val`,
          { headers: standbyHeaders, signal: AbortSignal.timeout(10_000) },
        ).catch(() => null as Response | null);
        if (res && res.ok) {
          const data = (await res.json()) as Array<{ val: string }>;
          const postDdl = data.filter((r) => r.val !== canaryVal).length;
          if (postDdl >= 2) {
            bothArrived = true;
            measurements["resume_lag_ms"] = Date.now() - resumeStart;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!bothArrived) {
        measurements["resume_lag_ms"] = -1;
      }
      measurements["recovery_success"] = bothArrived ? "true" : "false";

      // Pass criteria: every outcome recorded verbatim. Any measured behavior passes.
      return {
        id: "W15",
        title: this.title,
        status: "pass",
        detail: canaryArrived
          ? `canary ${measurements["canary_synced_ms"]}ms, stalled=${measurements["stalled_before_standby_ddl"]}, recovery=${measurements["recovery_success"]}, resume_lag=${measurements["resume_lag_ms"]}ms`
          : `subscription created but canary row did not arrive in 60s; stall/recovery measurements still recorded`,
        measurements,
      };
    } catch (e: any) {
      return { id: "W15", title: this.title, status: "fail", detail: e.message, measurements };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
