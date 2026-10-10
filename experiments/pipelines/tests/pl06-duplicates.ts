/**
 * PL06 - duplicates after a forced restart.
 *
 * Docs claim: "Pipelines provides at-least-once processing: recovery can replay
 * acknowledged data, and consumers of append-only histories must tolerate
 * repeated events. Destination deduplication does not provide an exactly-once
 * processing guarantee." The DuckLake guide says insert-only tables (no usable
 * row identity) are allowed.
 *
 * Two published tables written continuously (about 100 rows/s each, explicit
 * sequential ids):
 *   pl06_pk    bigint primary key
 *   pl06_nopk  no primary key (REPLICA IDENTITY DEFAULT: insert-only)
 *
 * Two phases, each a fresh pipeline and destination:
 *   phase "default"  engine default batch wait; SIGKILL at a random point 25-34 s
 *                    into the load, four trials, then one SIGTERM control
 *   phase "1s"       batch wait 1000 ms (a commit about every second, so a
 *                    kill lands near one more often); SIGKILL 8-19 s into the
 *                    load, six trials
 * The writer keeps running while the container is down and after it restarts.
 * After each trial the module waits for the destination to hold every source
 * id, then reports rows minus distinct ids per table, counted through the
 * DuckLake catalog.
 *
 * Entity note: engine, not the managed service (see PL02). A managed
 * "restart pipeline" or platform-initiated restart is not observed.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { beginPipeline, ensureFixture, openDuck, withCleanup } from "../lib/fixture.js";
import {
  SrcDb,
  killReplicator,
  replicatorRunning,
  rootCert,
  sleep,
  startReplicator,
  stopReplicator,
  tableStates,
  waitTablesReady,
} from "../lib/stack.js";

interface Phase {
  label: string;
  maxFillMs?: number;
  kills: number;
  offsetMinS: number;
  offsetSpanS: number;
  graceful: number;
}

const PHASES: Phase[] = [
  { label: "default", kills: Number(process.env.PL_KILL_TRIALS ?? 4), offsetMinS: 25, offsetSpanS: 10, graceful: 1 },
  { label: "1s", maxFillMs: 1000, kills: Number(process.env.PL_KILL_TRIALS_1S ?? 6), offsetMinS: 8, offsetSpanS: 12, graceful: 0 },
];

const mod: TestModule = {
  id: "PL06",
  title: "PL06 - duplicates after a forced restart",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const fx = await ensureFixture(ctx);
    const { db, state } = fx;
    const tables = ["public.pl06_pk", "public.pl06_nopk"];
    const writer = new SrcDb(state, await rootCert(state));
    let next = 2000;
    let writerErr = "";
    /** Insert 20 rows into each table every ~150 ms until stopped. */
    const startWriter = () => {
      let stop = false;
      const loop = (async () => {
        while (!stop) {
          const a = next;
          const b = next + 19;
          next = b + 1;
          try {
            await writer.q(`insert into public.pl06_pk select g, 'w' from generate_series(${a}, ${b}) g`);
            await writer.q(`insert into public.pl06_nopk select g, 'w' from generate_series(${a}, ${b}) g`);
          } catch (e) {
            writerErr = e instanceof Error ? e.message : String(e);
          }
          await sleep(150);
        }
      })();
      return async () => {
        stop = true;
        await loop;
      };
    };

    let totalDupPk = 0;
    let totalDupNp = 0;
    let trialsRun = 0;
    try {
      for (const ph of PHASES) {
        await db.q("drop table if exists public.pl06_pk cascade");
        await db.q("drop table if exists public.pl06_nopk cascade");
        await db.q("create table public.pl06_pk (id bigint primary key, v text)");
        await db.q("create table public.pl06_nopk (id bigint, v text)");
        await db.q("insert into public.pl06_pk select g, 'seed' from generate_series(1, 1000) g");
        await db.q("insert into public.pl06_nopk select g, 'seed' from generate_series(1, 1000) g");
        next = 2000;
        const opts = { tables, tag: "pl06", maxFillMs: ph.maxFillMs };
        await beginPipeline(fx, opts);
        const w = await waitTablesReady(db, tables, 300_000, 2000, ["sync_done", "ready"]);
        if (!w.ok) {
          results.push({ id: `PL06-${ph.label}-setup`, title: "PL06 setup", status: "fail", detail: `copy: ${JSON.stringify(w.states)}` });
          continue;
        }
        // promote to ready with a little WAL activity
        for (let i = 0; i < 30; i++) {
          const s = await tableStates(db, tables);
          if (tables.every((t) => s[t] === "ready")) break;
          await db.q("insert into public.pl06_pk values ($1, 'hb')", [900_000 + i]);
          await db.q("insert into public.pl06_nopk values ($1, 'hb')", [900_000 + i]);
          await sleep(2000);
        }

        const duck = await openDuck();
        const counts = async () => {
          const r = await duck.rows(
            `select (select count(*) from lake.public.pl06_pk), (select count(distinct id) from lake.public.pl06_pk),
                    (select count(*) from lake.public.pl06_nopk), (select count(distinct id) from lake.public.pl06_nopk)`,
          );
          const x = (r[0] ?? []).map(Number);
          return { pk: x[0] ?? NaN, pkDistinct: x[1] ?? NaN, np: x[2] ?? NaN, npDistinct: x[3] ?? NaN };
        };
        const srcCounts = async () => ({
          pk: Number(await db.scalar("select count(*) from public.pl06_pk")),
          np: Number(await db.scalar("select count(*) from public.pl06_nopk")),
        });

        let prevDupPk = 0;
        let prevDupNp = 0;
        try {
          const plan: Array<{ kind: "kill" | "term"; offsetS: number }> = [];
          for (let i = 0; i < ph.kills; i++) plan.push({ kind: "kill", offsetS: ph.offsetMinS + Math.floor(Math.random() * ph.offsetSpanS) });
          for (let i = 0; i < ph.graceful; i++) plan.push({ kind: "term", offsetS: 30 });
          let n = 0;
          for (const t of plan) {
            n += 1;
            const stopWriting = startWriter();
            await sleep(t.offsetS * 1000);
            const before = await counts();
            const srcBefore = await srcCounts();
            const tStop = Date.now();
            if (t.kind === "kill") await killReplicator();
            else await stopReplicator(60);
            const stopMs = Date.now() - tStop;
            await sleep(5000); // the writer keeps going while the pipeline is down
            const tRestart = Date.now();
            const st = await startReplicator(state, opts);
            if (st.code !== 0) throw new Error(`restart failed: ${st.out.slice(-200)}`);
            await sleep(15_000); // writer still running after the restart
            await stopWriting();
            const srcNow = await srcCounts();
            let c = await counts();
            let stableSince = Date.now();
            let last = `${c.pk}/${c.np}`;
            const deadline = Date.now() + 240_000;
            let converged = false;
            while (Date.now() < deadline) {
              await sleep(3000);
              c = await counts();
              const sig = `${c.pk}/${c.np}`;
              if (sig !== last) {
                last = sig;
                stableSince = Date.now();
              }
              if (c.pkDistinct === srcNow.pk && c.npDistinct === srcNow.np && Date.now() - stableSince >= 20_000) {
                converged = true;
                break;
              }
            }
            const dupPk = c.pk - c.pkDistinct;
            const dupNp = c.np - c.npDistinct;
            trialsRun += 1;
            results.push({
              id: `PL06-${ph.label}-${n}`,
              title: `PL06 ${ph.label} trial ${n}: ${t.kind === "kill" ? `SIGKILL at ${t.offsetS} s` : "SIGTERM (graceful stop) at 30 s"}`,
              status: "info",
              detail: converged
                ? `destination caught up; duplicate rows this trial: pk table ${dupPk - prevDupPk}, no-pk table ${dupNp - prevDupNp}`
                : "destination did not converge within 240 s",
              measurements: {
                batch_max_fill_ms: ph.maxFillMs ?? 10000,
                signal: t.kind === "kill" ? "SIGKILL" : "SIGTERM",
                stop_call_ms: stopMs,
                restart_to_converged_s: Math.round((Date.now() - tRestart) / 1000),
                src_rows_pk: srcNow.pk,
                src_rows_nopk: srcNow.np,
                dest_rows_pk: c.pk,
                dest_distinct_ids_pk: c.pkDistinct,
                dest_rows_nopk: c.np,
                dest_distinct_ids_nopk: c.npDistinct,
                duplicates_pk_this_trial: dupPk - prevDupPk,
                duplicates_nopk_this_trial: dupNp - prevDupNp,
                dest_rows_before_stop_pk: before.pk,
                src_rows_before_stop_pk: srcBefore.pk,
                converged: converged ? "yes" : "no",
              },
            });
            prevDupPk = dupPk;
            prevDupNp = dupNp;
            if (!converged || !(await replicatorRunning())) break;
          }
          totalDupPk += prevDupPk;
          totalDupNp += prevDupNp;
        } finally {
          duck.close();
        }
      }
      results.push({
        id: "PL06-total",
        title: "PL06 total: duplicate rows across all trials",
        status: "info",
        detail: writerErr ? `writer error seen: ${writerErr.slice(0, 100)}` : undefined,
        measurements: {
          trials_run: trialsRun,
          duplicates_pk_total: totalDupPk,
          duplicates_nopk_total: totalDupNp,
        },
      });
    } finally {
      await writer.close();
    }
    return results;
  },
};

export default withCleanup(mod);
