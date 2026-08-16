/**
 * W16 - sequence resync at cutover
 *
 * Measures whether the sequence on a 
 * standby can be resynced after a 
 * cutover event where direct writes to the standby 
 * caused a primary-key collision due to the sequence 
 * being out of sync.
 *
 * Steps:
 * 1. Replicate public.w16_t(id serial primary key, val text) W05-style
 *    (copy_data=false, streaming=on).
 * 2. Insert 5 rows on the primary; confirm they stream to the standby.
 * 3. Simulate cutover: Insert a row DIRECTLY on the standby. 
 *    Expect error (duplicate key) because the standby's sequence is behind.
 * 4. Resync on standby: `setval` to max(id) + 1.
 * 5. Verify: Insert on standby; expect success.
 *
 * Cleanup: drop subscription, publication, and slots (W15/W05 pattern).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W16",
  title: "sequence resync at cutover",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const dbPw = ctx.dbPassword;
    const standbyAnon = ctx.endpoints["standby_anon"];
    const measurements: Record<string, string | number> = {};

    if (!standby || !dbPw) {
      return {
        id: "W16",
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

    const cleanup = async () => {
      // ALTER SUBSCRIPTION has no IF EXISTS (W09 note) - the .catch swallows
      // the not-exists error.
      await runSql(standby, `ALTER SUBSCRIPTION IF EXISTS w16_sub DISABLE`).catch(() => {});
      await runSql(standby, `ALTER SUBSCRIPTION w16_sub SET (slot_name = none)`).catch(() => {});
      await runSql(standby, `DROP SUBSCRIPTION IF EXISTS w16_sub`).catch(() => {});
      await runSql(primary, `DROP PUBLICATION IF EXISTS w16_pub`).catch(() => {});
      await runSql(primary, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'w16_sub'`).catch(() => {});
      await runSql(primary, `DROP TABLE IF EXISTS public.w16_t`).catch(() => {});
      await runSql(standby, `DROP TABLE IF EXISTS public.w16_t`).catch(() => {});
    };

    try {
      // 1. Setup replication
      await runSql(primary, `DROP TABLE IF EXISTS public.w16_t; CREATE TABLE public.w16_t(id serial primary key, val text)`);
      await runSql(primary, `DROP PUBLICATION IF EXISTS w16_pub`);
      await runSql(primary, `CREATE PUBLICATION w16_pub FOR TABLE public.w16_t`);
      await runSql(standby, `DROP TABLE IF EXISTS public.w16_t; CREATE TABLE public.w16_t(id serial primary key, val text)`);
      
      const directConn = `host=db.${primary}.supabase.co port=5432 dbname=postgres user=postgres password=${dbPw} sslmode=require connect_timeout=15`;
      await runSql(standby, `CREATE SUBSCRIPTION w16_sub CONNECTION '${directConn}' PUBLICATION w16_pub WITH (copy_data = false, streaming = on)`);
      
      measurements["replication_setup"] = "true";

      // 2. Populate primary and confirm streaming
      await runSql(primary, `TRUNCATE public.w16_t`);
      await runSql(primary, `INSERT INTO public.w16_t (val) VALUES ('r1'), ('r2'), ('r3'), ('r4'), ('r5')`);

      const standbyHeaders = { apikey: standbyAnon!, Authorization: `Bearer ${standbyAnon!}` };
      
      const syncStart = Date.now();
      let rowsSynced = 0;
      while (Date.now() - syncStart < 60_000) {
        const res = await fetch(`https://${standby}.supabase.co/rest/v1/w16_t?select=id`, {
          headers: standbyHeaders,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          const data = (await res.json()) as unknown[];
          rowsSynced = data.length;
          if (rowsSynced >= 5) break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      measurements["rows_synced_to_standby"] = rowsSynced;
      if (rowsSynced < 5) throw new Error(`Streaming failed: only ${rowsSynced} rows arrived`);

      // 3. Simulate cutover: Insert on standby -> error
      let collisionError = "";
      try {
        await runSql(standby, `INSERT INTO public.w16_t (val)
          VALUES ('collision')`);
      } catch (e: any) {
        collisionError = e.message;
        measurements["collision_error"] = collisionError;
      }
      if (!collisionError.includes("duplicate key")) {
        throw new Error(`Expected duplicate key error, but got: ${collisionError}`);
      }

      // 4. Resync on standby
      await runSql(standby, `SELECT setval(pg_get_serial_sequence('public.w16_t','id'), coalesce((select max(id) from public.w16_t),0) + 1, false)`);
      measurements["resync_applied"] = "true";

      // 5. Verify: Insert on standby -> success
      await runSql(standby, `INSERT INTO public.w16_t (val) VALUES ('success')`);
      measurements["post_resync_insert"] = "success";

      return {
        id: "W16",
        title: this.title,
        status: "pass",
        detail: "Sequence resync successful after primary-key collision.",
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W16",
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
