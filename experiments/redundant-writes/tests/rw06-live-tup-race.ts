/**
 * RW06 - can n_live_tup over-count after a load and a VACUUM (ANALYZE) on the
 * same connection?
 *
 * A smoke run of RW04 at 1,000 rows on 2026-10-08 read n_live_tup = 2,000 for
 * a 1,000-row table whose insert and VACUUM (ANALYZE) ran on one connection;
 * at 1,000,000 rows the same flow read the true count. The reading this module
 * tests: a backend flushes its pending table counters when it goes idle, but
 * not more often than once a second, so a quick insert's +N live rows can
 * still be pending when VACUUM reports its own absolute count, and the
 * deferred flush then adds N on top. A slow insert (over a second) flushes
 * before the VACUUM starts and nothing doubles.
 *
 * Per target x size (1,000 / 10,000 / 100,000 / 1,000,000), RW_REPS times:
 *   same_session: create + insert N + VACUUM (ANALYZE), one connection; read
 *                 n_live_tup from a new connection after FLUSH_WAIT_MS.
 *   two_sessions: the insert's connection closes, then VACUUM (ANALYZE) runs on
 *                 a second one; same read.
 * Records insert ms, so a doubling can be set against the 1 s flush interval.
 *
 * DESTRUCTIVE on the rig only (creates and drops public.t_live).
 *
 * Not settled by this module: the server-side flush timing itself (not
 * instrumented); whether autovacuum's own report races the same way.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { FLUSH_WAIT_MS, median, readTableStats, reps, rigUp, sleep, targets, withConn } from "../lib/rig";

const ID = "RW06";
const SIZES = [1_000, 10_000, 100_000, 1_000_000];

const CREATE = "create table public.t_live (id bigint primary key, b text not null) with (autovacuum_enabled = false)";
const INSERT = "insert into public.t_live select g, md5(g::text) from generate_series(1, $1::bigint) g";

const mod: TestModule = {
  id: ID,
  title: "n_live_tup after insert + VACUUM (ANALYZE) on one connection vs two",
  where: "local",
  requires: [],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    for (const t of targets()) {
      if (!(await rigUp(t))) {
        out.push({ id: `${ID}-${t.role}`, title: this.title, status: "skip", detail: `not answering on 127.0.0.1:${t.port}` });
        continue;
      }
      for (const n of SIZES) {
        const same: number[] = [];
        const two: number[] = [];
        const insMs: number[] = [];
        for (let i = 0; i < reps(); i++) {
          await withConn(t, async (c) => {
            await c.query("drop table if exists public.t_live");
            await c.query(CREATE);
            const t0 = performance.now();
            await c.query(INSERT, [n]);
            insMs.push(Math.round((performance.now() - t0) * 10) / 10);
            await c.query("vacuum (analyze) public.t_live");
          });
          await sleep(FLUSH_WAIT_MS);
          same.push(await withConn(t, async (c) => (await readTableStats(c, "t_live")).n_live_tup));

          await withConn(t, async (c) => {
            await c.query("drop table if exists public.t_live");
            await c.query(CREATE);
            await c.query(INSERT, [n]);
          });
          await sleep(FLUSH_WAIT_MS);
          await withConn(t, (c) => c.query("vacuum (analyze) public.t_live"));
          await sleep(FLUSH_WAIT_MS);
          two.push(await withConn(t, async (c) => (await readTableStats(c, "t_live")).n_live_tup));
        }
        await withConn(t, (c) => c.query("drop table if exists public.t_live"));
        ctx.log(`${ID}-${t.role}-${n}: same=${same.join(",")} two=${two.join(",")} insert_ms=${insMs.join(",")}`);
        out.push({
          id: `${ID}-${t.role}-${n}`,
          title: this.title,
          status: "info",
          detail: `${t.image}, ${n} rows`,
          measurements: {
            target: t.role,
            rows: n,
            same_session_n_live_tup: same.join(","),
            two_sessions_n_live_tup: two.join(","),
            insert_ms: insMs.join(","),
            insert_ms_median: median(insMs),
          },
        });
      }
    }
    return out;
  },
};

export default mod;
