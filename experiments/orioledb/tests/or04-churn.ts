/**
 * OR04 - does repeated rewriting of unchanged rows grow the table (bloat), and
 * does autovacuum act on an OrioleDB table?
 *
 *   OR04a-<target>  100,000-row table, autovacuum disabled by reloption where
 *                   the engine accepts it, ten rounds of the plain
 *                   `UPDATE ... FROM src` over every row. Per round: relation
 *                   size, index size, `n_dead_tup` (pg_stat_user_tables), WAL
 *                   bytes (LSN diff). Then a manual `VACUUM`, and `VACUUM FULL`,
 *                   with sizes after each. Targets: `oriole_oriole`,
 *                   `oriole_heap`, `heap_heap` (see OR02).
 *   OR04b           same project, autovacuum ON (default reloptions): an
 *                   OrioleDB table and a heap table, 100,000 rows, three
 *                   all-row UPDATE rounds, then poll every 15 s for up to
 *                   OR_AV_WAIT_S seconds (default 180) for `autovacuum_count`
 *                   and `last_autovacuum` to move and for `n_dead_tup` to
 *                   fall. The OrioleDB table's `n_dead_tup` counter rises on
 *                   UPDATE (OR02); this records whether autovacuum acts on
 *                   that counter and whether anything is reclaimed.
 *
 * DESTRUCTIVE on the pair only.
 *
 * Not settled: churn from deletes or from index-key updates, long-running
 * readers holding old versions (the case undo logs and vacuum differ on most),
 * or anything over ten rounds.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { UPDATE_PLAIN } from "../../redundant-writes/lib/cases";
import { skipWithoutOrg, sleep, tryQuery, withConn } from "../lib/pair";
import { buildFixture, forceFlush, readTableStats, FLUSH_WAIT_MS } from "../lib/rig";
import { targets } from "../lib/matrix";

const ID = "OR04";
const ROUNDS = 10;
const N = 100_000;

const mod: TestModule = {
  id: ID,
  title: "Churn: ten all-row UPDATE rounds, size and dead-tuple counters, autovacuum on an OrioleDB table",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title);
    if (skipped) return skipped;
    const out: TestResult[] = [];

    for (const t of await targets(ctx)) {
      const rid = `${ID}a-${t.key}`;
      try {
        const av = await buildFixture(t, N, "identical");
        const m: Record<string, string | number> = { target: t.key, rows: N, rounds: ROUNDS, autovacuum_reloption_accepted: av.autovacuumOff ? 1 : 0 };
        const size = async (c: import("pg").Client) =>
          (await c.query("select pg_relation_size('public.t')::bigint as r, pg_indexes_size('public.t')::bigint as i, pg_total_relation_size('public.t')::bigint as tot")).rows[0];
        const s0 = await withConn(t.proj, size);
        m.size_start_bytes = Number(s0.r);
        m.index_start_bytes = Number(s0.i);
        m.total_start_bytes = Number(s0.tot);
        const walPerRound: number[] = [];
        for (let r = 1; r <= ROUNDS; r++) {
          const row = await withConn(t.proj, async (c) => {
            const lsn0 = (await c.query("select pg_current_wal_insert_lsn()::text as l")).rows[0].l as string;
            await c.query(UPDATE_PLAIN);
            const d = Number((await c.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint as d", [lsn0])).rows[0].d);
            await forceFlush(c);
            return d;
          });
          walPerRound.push(row);
          await sleep(FLUSH_WAIT_MS);
          if (r === 1 || r === 5 || r === ROUNDS) {
            const x = await withConn(t.proj, async (c) => ({ sz: await size(c), st: await readTableStats(c) }));
            m[`size_after_round_${r}_bytes`] = Number(x.sz.r);
            m[`index_after_round_${r}_bytes`] = Number(x.sz.i);
            m[`n_dead_tup_after_round_${r}`] = x.st.n_dead_tup;
            m[`n_tup_upd_after_round_${r}`] = x.st.n_tup_upd;
          }
        }
        m.wal_bytes_round_1 = walPerRound[0]!;
        m.wal_bytes_round_10 = walPerRound[ROUNDS - 1]!;
        m.wal_bytes_all_rounds = walPerRound.reduce((a, b) => a + b, 0);
        const v = await withConn(t.proj, async (c) => {
          const r = await tryQuery(c, "vacuum public.t");
          const sz = await size(c);
          return { r, sz };
        });
        m.vacuum_result = v.r.ok ? "ok" : v.r.error;
        m.size_after_vacuum_bytes = Number(v.sz.r);
        const vf = await withConn(t.proj, async (c) => {
          const r = await tryQuery(c, "vacuum full public.t");
          const sz = await size(c);
          return { r, sz };
        });
        m.vacuum_full_result = vf.r.ok ? "ok" : vf.r.error;
        m.size_after_vacuum_full_bytes = Number(vf.sz.r);
        out.push({
          id: rid,
          title: this.title,
          status: "info",
          detail: `${t.label}: ${m.size_start_bytes} B at start, ${m.size_after_round_10_bytes} B after ${ROUNDS} rounds`,
          measurements: m,
        });
      } catch (e) {
        out.push({ id: rid, title: this.title, status: "fail", detail: `error: ${(e as Error).message.slice(0, 300)}` });
      }
    }

    // OR04b - autovacuum on, in the OrioleDB project only.
    const pair = (await targets(ctx)).find((t) => t.key === "oriole_oriole")?.proj;
    if (!pair) {
      out.push({ id: `${ID}b`, title: this.title, status: "skip", detail: "oriole_oriole target not selected" });
      return out;
    }
    try {
      const waitS = Number(process.env.OR_AV_WAIT_S ?? "180");
      await withConn(pair, async (c) => {
        await c.query("drop table if exists public.av_o, public.av_h, public.av_src");
        await c.query("create table public.av_o (id bigint primary key, a int not null, b text not null) using orioledb");
        await c.query("create table public.av_h (id bigint primary key, a int not null, b text not null) using heap");
        await c.query("insert into public.av_o select g, (g % 1000)::int, md5(g::text) from generate_series(1, $1::bigint) g", [N]);
        await c.query("insert into public.av_h select g, (g % 1000)::int, md5(g::text) from generate_series(1, $1::bigint) g", [N]);
        await c.query("create table public.av_src as select * from public.av_h");
        await c.query("analyze public.av_o");
        await c.query("analyze public.av_h");
      });
      const read = async () =>
        withConn(pair, async (c) => {
          await forceFlush(c);
          return (
            await c.query(
              `select relname, n_dead_tup, n_tup_upd, autovacuum_count, vacuum_count, autoanalyze_count, to_char(last_autovacuum, 'HH24:MI:SS') as last_av, to_char(last_autoanalyze, 'HH24:MI:SS') as last_aa,
                      pg_relation_size(relid)::bigint as bytes
                 from pg_stat_user_tables where relname in ('av_o','av_h')`,
            )
          ).rows as Array<{ relname: string; n_dead_tup: string; n_tup_upd: string; autovacuum_count: string; vacuum_count: string; autoanalyze_count: string; last_av: string | null; last_aa: string | null; bytes: string }>;
        });
      for (let r = 0; r < 3; r++) {
        await withConn(pair, async (c) => {
          await c.query("update public.av_o t set a = s.a, b = s.b from public.av_src s where t.id = s.id");
          await c.query("update public.av_h t set a = s.a, b = s.b from public.av_src s where t.id = s.id");
        });
      }
      await sleep(FLUSH_WAIT_MS);
      const first = await read();
      const m: Record<string, string | number> = { rows: N, update_rounds: 3, wait_s: waitS };
      for (const x of first) {
        m[`${x.relname}_n_dead_tup_at_0s`] = Number(x.n_dead_tup);
        m[`${x.relname}_bytes_at_0s`] = Number(x.bytes);
      }
      const t0 = Date.now();
      let last = first;
      const moved: Record<string, number> = {};
      while ((Date.now() - t0) / 1000 < waitS) {
        await sleep(15_000);
        last = await read();
        for (const x of last) {
          if (Number(x.autovacuum_count) > 0 && moved[x.relname] === undefined) moved[x.relname] = Math.round((Date.now() - t0) / 1000);
        }
        if (moved.av_o !== undefined && moved.av_h !== undefined) break;
      }
      for (const x of last) {
        m[`${x.relname}_autovacuum_count`] = Number(x.autovacuum_count);
        m[`${x.relname}_last_autovacuum`] = x.last_av ?? "never";
        m[`${x.relname}_autoanalyze_count`] = Number(x.autoanalyze_count);
        m[`${x.relname}_last_autoanalyze`] = x.last_aa ?? "never";
        m[`${x.relname}_n_dead_tup_at_end`] = Number(x.n_dead_tup);
        m[`${x.relname}_bytes_at_end`] = Number(x.bytes);
        m[`${x.relname}_first_autovacuum_s`] = moved[x.relname] ?? -1;
      }
      m.waited_s = Math.round((Date.now() - t0) / 1000);
      out.push({
        id: `${ID}b`,
        title: this.title,
        status: "info",
        detail: `autovacuum_count av_o=${m.av_o_autovacuum_count} av_h=${m.av_h_autovacuum_count} after ${m.waited_s} s`,
        measurements: m,
      });
      await withConn(pair, (c) => c.query("drop table if exists public.av_o, public.av_h, public.av_src"));
    } catch (e) {
      out.push({ id: `${ID}b`, title: this.title, status: "fail", detail: `error: ${(e as Error).message.slice(0, 300)}` });
    }
    return out;
  },
};

export default mod;
