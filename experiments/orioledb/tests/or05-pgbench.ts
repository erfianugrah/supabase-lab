/**
 * OR05 - a short pgbench pair: the same TPC-B-like transaction against a heap
 * table set in the heap control, a heap table set in the OrioleDB project, and
 * an OrioleDB table set in the OrioleDB project.
 *
 * Tables are built by SQL rather than `pgbench -i`, because `-i` has no way
 * to choose the table access method per table set through the pooler
 * (startup parameters are not carried). Each target gets its own schema
 * (`pb_<target>`) holding the four pgbench tables (same columns and primary
 * keys as pgbench's own, scale OR_PB_SCALE, default 20 = 2,000,000 accounts)
 * and a function `tpcb()` with the transaction body. Three scripts, each run
 * with `pgbench -n -c OR_PB_CLIENTS -j 4 -T OR_PB_SECONDS` (defaults 12
 * clients, 30 s; the session-mode pooler refuses more than 15 client
 * connections per project, EMAXCONNSESSION, measured in a smoke run),
 * OR_PB_REPS runs per cell (default 2) in alternating target order, after one
 * discarded warm-up run per target. The `tpcb_fn` script also runs at 4
 * clients (`tpcb_fn_c4`) to show whether throughput scales with clients:
 *
 *   tpcb_like   the built-in tpcb-like script with schema-qualified names:
 *               BEGIN, UPDATE accounts, SELECT abalance, UPDATE tellers,
 *               UPDATE branches, INSERT history, END (7 round trips)
 *   tpcb_fn     `select pb.tpcb(...)` - the same statements in one function
 *               call, one round trip per transaction
 *   select_only `SELECT abalance FROM accounts WHERE aid = :aid`
 *
 * Vantage: this machine, through the session-mode pooler, with the round trip
 * measured first (OR05-rtt: `select 1`, one client, 5 s). The tpcb_like
 * result is bounded by clients / (7 x round trip) when the server has
 * headroom; tpcb_fn needs one round trip per transaction. The pooler sits in
 * the path of every cell equally. OR05-sizes records table sizes and the
 * autovacuum counters after all runs.
 *
 * Confounds that are part of the pair, not removed by it: the OrioleDB
 * project reports Postgres 17.6 on aarch64 and the heap control 17.11 on
 * x86_64 (OR01b), so heap-control vs OrioleDB-project cells differ in engine,
 * Postgres build and CPU architecture. The same-project pair
 * (`oriole_oriole` vs `oriole_heap`) shares all three.
 *
 * DESTRUCTIVE on the pair only. Requires `pgbench` on PATH.
 *
 * Not settled: throughput at the 8xlarge size the public benchmark uses, any
 * run longer than 30 s, any client count other than OR_PB_CLIENTS, writes
 * from inside the region.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { connString, skipWithoutOrg, tryQuery, withConn, type Proj } from "../lib/pair";
import { targets } from "../lib/matrix";
import type { Target } from "../lib/rig";

const ID = "OR05";
const num = (k: string, d: number) => {
  const n = Number(process.env[k] ?? d);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const SCALE = () => num("OR_PB_SCALE", 20);
const CLIENTS = () => num("OR_PB_CLIENTS", 12);
const SECONDS = () => num("OR_PB_SECONDS", 30);
const REPS = () => num("OR_PB_REPS", 2);

const schemaOf = (t: Target) => `pb_${t.key}`;

async function setup(t: Target): Promise<void> {
  const s = schemaOf(t);
  const sc = SCALE();
  await withConn(t.proj, async (c) => {
    await c.query(`drop schema if exists ${s} cascade`);
    await c.query(`create schema ${s}`);
    const am = `using ${t.am}`;
    await c.query(`create table ${s}.pgbench_branches (bid int not null primary key, bbalance int, filler char(88)) ${am}`);
    await c.query(`create table ${s}.pgbench_tellers (tid int not null primary key, bid int, tbalance int, filler char(84)) ${am}`);
    await c.query(`create table ${s}.pgbench_accounts (aid int not null primary key, bid int, abalance int, filler char(84)) ${am}`);
    await c.query(`create table ${s}.pgbench_history (tid int, bid int, aid int, delta int, mtime timestamp, filler char(22)) ${am}`);
    await c.query(`insert into ${s}.pgbench_branches select g, 0, '' from generate_series(1, $1::int) g`, [sc]);
    await c.query(`insert into ${s}.pgbench_tellers select g, (g - 1) / 10 + 1, 0, '' from generate_series(1, $1::int) g`, [sc * 10]);
    await c.query(`insert into ${s}.pgbench_accounts select g, (g - 1) / 100000 + 1, 0, '' from generate_series(1, $1::int) g`, [sc * 100000]);
    await c.query(`vacuum analyze ${s}.pgbench_branches`);
    await c.query(`vacuum analyze ${s}.pgbench_tellers`);
    await c.query(`vacuum analyze ${s}.pgbench_accounts`);
    await c.query(
      `create function ${s}.tpcb(p_aid int, p_tid int, p_bid int, p_delta int) returns int language plpgsql as $f$
       declare bal int;
       begin
         update ${s}.pgbench_accounts set abalance = abalance + p_delta where aid = p_aid;
         select abalance into bal from ${s}.pgbench_accounts where aid = p_aid;
         update ${s}.pgbench_tellers set tbalance = tbalance + p_delta where tid = p_tid;
         update ${s}.pgbench_branches set bbalance = bbalance + p_delta where bid = p_bid;
         insert into ${s}.pgbench_history (tid, bid, aid, delta, mtime) values (p_tid, p_bid, p_aid, p_delta, current_timestamp);
         return bal;
       end $f$`,
    );
  });
}

function scripts(s: string): Record<string, string> {
  const head =
    "\\set aid random(1, 100000 * :scale)\n\\set bid random(1, 1 * :scale)\n\\set tid random(1, 10 * :scale)\n\\set delta random(-5000, 5000)\n";
  return {
    tpcb_like:
      head +
      `BEGIN;\nUPDATE ${s}.pgbench_accounts SET abalance = abalance + :delta WHERE aid = :aid;\nSELECT abalance FROM ${s}.pgbench_accounts WHERE aid = :aid;\n` +
      `UPDATE ${s}.pgbench_tellers SET tbalance = tbalance + :delta WHERE tid = :tid;\nUPDATE ${s}.pgbench_branches SET bbalance = bbalance + :delta WHERE bid = :bid;\n` +
      `INSERT INTO ${s}.pgbench_history (tid, bid, aid, delta, mtime) VALUES (:tid, :bid, :aid, :delta, CURRENT_TIMESTAMP);\nEND;\n`,
    tpcb_fn: head + `SELECT ${s}.tpcb(:aid, :tid, :bid, :delta);\n`,
    select_only: head + `SELECT abalance FROM ${s}.pgbench_accounts WHERE aid = :aid;\n`,
  };
}

interface PgbenchOut {
  /** Server-side mean statement time per transaction, from pg_stat_statements deltas (ms); NaN when unreadable. */
  server_ms: number;
  tps: number;
  latency_ms: number;
  latency_stddev_ms: number;
  txns: number;
  failed: number;
  conn_ms: number;
  raw: string;
}

async function pgbench(p: Proj, file: string, clients: number, seconds: number): Promise<PgbenchOut> {
  const cs = connString(p);
  const proc = Bun.spawn(
    ["pgbench", "-n", "-f", file, "-c", String(clients), "-j", String(Math.min(4, clients)), "-T", String(seconds), "-D", `scale=${SCALE()}`],
    {
      env: {
        ...process.env,
        PGHOST: cs.host,
        PGPORT: String(cs.port),
        PGUSER: cs.user,
        PGPASSWORD: cs.password,
        PGDATABASE: cs.database,
        PGSSLMODE: "require",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // A hung connection through the pooler once held a run for 27 minutes (2026-10-10); bound it.
  const killer = setTimeout(() => proc.kill(), (seconds + 45) * 1000);
  const [so, se] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(killer);
  await proc.exited;
  // The script path is a per-user temp dir; keep it out of published evidence.
  const raw = `${so}\n${se}`.trim().replace(/\/(?:var\/folders|tmp|private)\/[^\s]*\/pvlab-or05-\d+\//g, "<tmp>/");
  const g = (re: RegExp) => Number(re.exec(raw)?.[1] ?? Number.NaN);
  return {
    server_ms: Number.NaN,
    tps: g(/tps = ([\d.]+) \(without initial connection time\)/),
    latency_ms: g(/latency average = ([\d.]+) ms/),
    latency_stddev_ms: g(/latency stddev = ([\d.]+) ms/),
    txns: g(/number of transactions actually processed: (\d+)/),
    failed: Number.isNaN(g(/number of failed transactions: (\d+)/)) ? 0 : g(/number of failed transactions: (\d+)/),
    conn_ms: g(/initial connection time = ([\d.]+) ms/),
    raw,
  };
}

const mod: TestModule = {
  id: ID,
  title: "pgbench pair: tpcb-like, one-round-trip tpcb function, select-only, on heap and OrioleDB tables",
  where: "local",
  requires: ["pat", "pgbench"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title);
    if (skipped) return skipped;
    const out: TestResult[] = [];
    const ts = await targets(ctx);
    const dir = join(tmpdir(), `pvlab-or05-${Date.now()}`);
    await Bun.$`mkdir -p ${dir}`.quiet();
    const files: Record<string, Record<string, string>> = {};
    for (const t of ts) {
      await setup(t);
      const sc = scripts(schemaOf(t));
      files[t.key] = {};
      for (const [name, body] of Object.entries(sc)) {
        const f = join(dir, `${t.key}-${name}.sql`);
        await Bun.write(f, body);
        files[t.key]![name] = f;
      }
      await Bun.write(join(dir, `${t.key}-rtt.sql`), "select 1;\n");
    }

    // Round trip per target, one client.
    for (const t of ts) {
      const r = await pgbench(t.proj, join(dir, `${t.key}-rtt.sql`), 1, 5);
      out.push({
        id: `${ID}-rtt-${t.key}`,
        title: this.title,
        status: "info",
        detail: `select 1, 1 client, 5 s: ${r.latency_ms} ms average`,
        measurements: { target: t.key, rtt_latency_ms: r.latency_ms, rtt_tps: r.tps },
      });
    }

    // Warm-up, discarded.
    for (const t of ts) await pgbench(t.proj, files[t.key]!.tpcb_fn!, CLIENTS(), 15);

    const cells: Record<string, PgbenchOut[]> = {};
    const MODES: Array<{ mode: string; script: string; clients: number }> = [
      { mode: "tpcb_like", script: "tpcb_like", clients: CLIENTS() },
      { mode: "tpcb_fn", script: "tpcb_fn", clients: CLIENTS() },
      { mode: "tpcb_fn_c4", script: "tpcb_fn", clients: 4 },
      { mode: "select_only", script: "select_only", clients: CLIENTS() },
    ];
    for (let rep = 0; rep < REPS(); rep++) {
      const order = rep % 2 === 0 ? ts : [...ts].reverse();
      for (const { mode, script, clients } of MODES) {
        for (const t of order) {
          await withConn(t.proj, (c) => c.query(`truncate ${schemaOf(t)}.pgbench_history`));
          const snap = async () =>
            withConn(t.proj, async (c) => {
              const r = await tryQuery(c, "select coalesce(sum(calls), 0)::float8 as n, coalesce(sum(total_exec_time), 0)::float8 as ms from pg_stat_statements where query like $1 and query not like 'truncate%'", [`%${schemaOf(t)}.%`]);
              return r.ok ? { n: Number(r.rows[0]?.n), ms: Number(r.rows[0]?.ms) } : undefined;
            });
          const before = await snap();
          const r = await pgbench(t.proj, files[t.key]![script]!, clients, SECONDS());
          const after = await snap();
          if (before && after && r.txns > 0) r.server_ms = (after.ms - before.ms) / r.txns;
          (cells[`${t.key}|${mode}`] ??= []).push(r);
          ctx.log(`${ID} ${t.key} ${mode} rep ${rep + 1}: tps=${r.tps} lat=${r.latency_ms} ms failed=${r.failed}`);
        }
      }
    }
    for (const t of ts) {
      for (const { mode, clients } of MODES) {
        const runs = cells[`${t.key}|${mode}`] ?? [];
        const tps = runs.map((r) => r.tps);
        out.push({
          id: `${ID}-${t.key}-${mode}`,
          title: this.title,
          status: runs.length && runs.every((r) => Number.isFinite(r.tps)) ? "pass" : "fail",
          detail: `${t.label}; ${clients} clients, ${SECONDS()} s, scale ${SCALE()}; tps per rep: ${tps.join(", ")}`,
          measurements: {
            target: t.key,
            mode,
            clients,
            seconds: SECONDS(),
            scale: SCALE(),
            reps: runs.length,
            tps_min: Math.min(...tps),
            tps_max: Math.max(...tps),
            tps_mean: Math.round((tps.reduce((a, b) => a + b, 0) / Math.max(1, tps.length)) * 10) / 10,
            latency_ms_mean: Math.round((runs.reduce((a, r) => a + r.latency_ms, 0) / Math.max(1, runs.length)) * 100) / 100,
            server_ms_per_txn_mean: Math.round((runs.reduce((a, r) => a + r.server_ms, 0) / Math.max(1, runs.length)) * 1000) / 1000,
            failed_txns: runs.reduce((a, r) => a + r.failed, 0),
            txns_total: runs.reduce((a, r) => a + r.txns, 0),
          },
          evidence: runs.map((r) => r.raw).join("\n-----\n"),
        });
      }
    }

    // Sizes and autovacuum counters after all runs.
    for (const t of ts) {
      const s = schemaOf(t);
      const m = await withConn(t.proj, async (c) => {
        await c.query("select pg_stat_force_next_flush()");
        const rows = (
          await c.query(
            `select relname, pg_relation_size(relid)::bigint as bytes, n_dead_tup, n_tup_upd, autovacuum_count
               from pg_stat_user_tables where schemaname = $1`,
            [s],
          )
        ).rows as Array<{ relname: string; bytes: string; n_dead_tup: string; n_tup_upd: string; autovacuum_count: string }>;
        const o: Record<string, number | string> = { target: t.key };
        for (const r of rows) {
          const k = r.relname.replace("pgbench_", "");
          o[`${k}_bytes`] = Number(r.bytes);
          o[`${k}_n_dead_tup`] = Number(r.n_dead_tup);
          o[`${k}_autovacuum_count`] = Number(r.autovacuum_count);
        }
        return o;
      });
      out.push({ id: `${ID}-sizes-${t.key}`, title: this.title, status: "info", detail: "table sizes and autovacuum counters after all runs", measurements: m });
      await withConn(t.proj, (c) => c.query(`drop schema if exists ${s} cascade`));
    }
    await Bun.$`rm -rf ${dir}`.quiet();
    return out;
  },
};

export default mod;
