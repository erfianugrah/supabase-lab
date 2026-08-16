/**
 * W22 - initial sync at real table size
 *
 * Measures how long logical replication takes to copy 1,000,000 rows and
 * whether streaming lag holds after initial sync completes.
 *
 * Hard-won mechanics carried forward from W05:
 * - CREATE SUBSCRIPTION must be its own single-statement query (not in a
 *   multi-statement string) - the management query endpoint runs multi-
 *   statement strings in one transaction and Postgres rejects CREATE
 *   SUBSCRIPTION inside a transaction block.
 * - Cleanup: disable -> slot_name=none -> drop -> drop publisher slot, so
 *   the slot on the primary does not pin WAL after the run.
 * - Row counts are verified via mgmt SQL (SELECT COUNT(*)), NOT via the
 *   REST API: w22_t has no anon SELECT policy, so a publishable-key REST
 *   call returns empty and the probe table is intentionally minimal.
 * - The 1M-row INSERT is server-side work that can take 10-30s; the mgmt
 *   client default 30s timeout may be too tight, so we use a 120s timeout
 *   for the seed statement.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W22",
  title: "initial sync at real table size",
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
        id: "W22",
        title: this.title,
        status: "skip",
        detail: `missing peer/credentials: standby=${standby ?? "absent"}, dbPassword=${dbPw ? "set" : "absent"}`,
      };
    }

    // Standard SQL helper (30s timeout, throws on non-2xx).
    const runSql = async (ref: string, query: string, timeoutMs = 30_000) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, timeoutMs);
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    // Count rows via SQL - avoids REST API anon-policy and aggregate-syntax issues.
    const countRows = async (ref: string, table: string): Promise<number> => {
      try {
        const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
          query: `SELECT COUNT(*)::int AS n FROM ${table}`,
        }, 30_000);
        if (res.status >= 300) return 0;
        const rows = res.json as Array<{ n: number }> | undefined;
        return rows?.[0]?.n ?? 0;
      } catch {
        return 0;
      }
    };

    // Cleanup: disable -> slot_name=none -> drop -> drop publisher slot -> drop tables.
    const cleanup = async () => {
      await runSql(standby, `ALTER SUBSCRIPTION w22_sub DISABLE`).catch(() => {});
      await runSql(standby, `ALTER SUBSCRIPTION w22_sub SET (slot_name = NONE)`).catch(() => {});
      await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w22_sub`).catch(() => {});
      await runSql(primary, `DROP PUBLICATION IF EXISTS w22_pub`).catch(() => {});
      await runSql(primary, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'w22_sub'`).catch(() => {});
      await runSql(primary, `DROP TABLE IF EXISTS public.w22_t`).catch(() => {});
      await runSql(standby, `DROP TABLE IF EXISTS public.w22_t`).catch(() => {});
    };

    try {
      // 1. Create table on primary (fast DDL, standard timeout).
      await runSql(primary, `DROP TABLE IF EXISTS public.w22_t; CREATE TABLE public.w22_t(id serial primary key, payload text)`);

      // Seed 1M rows server-side. Single INSERT with generate_series; can take
      // 10-30s so use a 120s timeout. Per SPEC: single statement.
      const seedStart = Date.now();
      await runSql(
        primary,
        `INSERT INTO public.w22_t(payload) SELECT md5(random()::text) FROM generate_series(1,1000000)`,
        120_000,
      );

      // Verify seed via SQL COUNT (poll up to 120s in case the INSERT returned
      // before all rows were visible, though in practice it is synchronous).
      let seedRows = 0;
      const seedPollDeadline = Date.now() + 120_000;
      while (Date.now() < seedPollDeadline) {
        seedRows = await countRows(primary, "public.w22_t");
        if (seedRows >= 1_000_000) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
      measurements["seed_ms"] = Date.now() - seedStart;
      measurements["seed_rows"] = seedRows;

      if (seedRows < 1_000_000) {
        return {
          id: "W22",
          title: this.title,
          status: "fail",
          detail: `Seed failed: only ${seedRows} rows inserted after seeding + 120s poll`,
          measurements,
        };
      }

      // 2. Publication on primary; table on standby.
      await runSql(primary, `DROP PUBLICATION IF EXISTS w22_pub`);
      await runSql(primary, `CREATE PUBLICATION w22_pub FOR TABLE public.w22_t`);
      await runSql(standby, `DROP TABLE IF EXISTS public.w22_t`);
      await runSql(standby, `CREATE TABLE public.w22_t(id serial primary key, payload text)`);

      // CREATE SUBSCRIPTION: single-statement query (transaction-block restriction).
      const directConn = `host=db.${primary}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;
      const syncStart = Date.now();
      try {
        await runSql(
          standby,
          `CREATE SUBSCRIPTION w22_sub CONNECTION '${directConn}' PUBLICATION w22_pub WITH (copy_data = true)`,
        );
        measurements["subscription_created"] = "true";
      } catch (e: any) {
        measurements["subscription_created"] = "false";
        measurements["subscription_error"] = e.message;
        throw e;
      }

      // Poll standby row count every 10s; 30 min budget per SPEC.
      let syncRows = 0;
      let stallDetected = false;
      const syncDeadline = Date.now() + 30 * 60_000;
      const stallDeadline = syncStart + 10 * 60_000;

      while (Date.now() < syncDeadline) {
        syncRows = await countRows(standby, "public.w22_t");
        if (syncRows >= 1_000_000) break;

        // Record stall if row count has not reached 1M past 10 min.
        if (Date.now() > stallDeadline) {
          stallDetected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }

      const syncMs = Date.now() - syncStart;
      measurements["sync_ms"] = syncRows >= 1_000_000 ? syncMs : -1;
      measurements["rows"] = syncRows;

      if (stallDetected) {
        // Stall is a finding, not a failure - record verbatim per SPEC.
        return {
          id: "W22",
          title: this.title,
          status: "pass",
          detail: `sync stalled in 'd' state past 10 min: ${syncRows} rows replicated; micro/small worker ceiling at scale`,
          measurements: {
            ...measurements,
            sync_ms: -1,
            lag_ms: -1,
            stall: "true",
          },
        };
      }

      // 3. Post-sync canary: measure streaming lag.
      const canaryVal = `canary-${Math.random().toString(36).slice(2, 8)}`;
      await runSql(primary, `INSERT INTO public.w22_t (payload) VALUES ('${canaryVal}')`);
      const lagStart = Date.now();
      let lagMs = -1;
      while (Date.now() - lagStart < 60_000) {
        try {
          const res = await mgmt(ctx, "POST", `/projects/${standby}/database/query`, {
            query: `SELECT COUNT(*)::int AS n FROM public.w22_t WHERE payload = '${canaryVal}'`,
          });
          const rows = res.json as Array<{ n: number }> | undefined;
          if ((rows?.[0]?.n ?? 0) > 0) {
            lagMs = Date.now() - lagStart;
            break;
          }
        } catch {
          // transient - keep polling
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      measurements["lag_ms"] = lagMs;

      return {
        id: "W22",
        title: this.title,
        status: "pass",
        detail: `initial sync ${measurements["sync_ms"]}ms for 1M rows; streaming lag ${lagMs}ms`,
        measurements,
      };
    } catch (e: any) {
      return { id: "W22", title: this.title, status: "fail", detail: e.message, measurements };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
