/**
 * PL03 - steady-state replication lag of the open-source replicator.
 *
 * One writer inserts a row every 0.8-1.6 s into a table whose pipeline is
 * `ready`; a DuckDB session attached to the DuckLake polls `max(id)`
 * continuously. Lag for a row is the laptop clock at the first poll that sees
 * it minus the laptop clock when the INSERT's commit was acknowledged, so both
 * ends share a clock. The poll's own duration is an upper-bound error and is
 * reported.
 *
 *   PL03a  engine default batch wait (`batch.max_fill_ms` 10000 ms; the managed
 *          docs list "Batch wait time" 10000 ms as the Dashboard default)
 *   PL03b  `batch.max_fill_ms` 1000 ms
 *
 * Same entity caveat as PL02: engine, not managed service, laptop in
 * Singapore, source in Frankfurt.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { beginPipeline, ensureFixture, openDuck, withCleanup } from "../lib/fixture.js";
import { sleep, waitTablesReady } from "../lib/stack.js";
import { pct, round } from "../lib/util.js";

const WINDOW_MS = Number(process.env.PL_LAG_WINDOW_MS ?? 90_000);

async function one(
  ctx: Ctx,
  id: string,
  title: string,
  maxFillMs: number | undefined,
  label: string,
): Promise<TestResult> {
  const fx = await ensureFixture(ctx);
  const { db } = fx;
  await db.q("drop table if exists public.pl03_lag cascade");
  await db.q("create table public.pl03_lag (id bigint generated always as identity primary key, v text)");
  await db.q("insert into public.pl03_lag(v) select 'seed' from generate_series(1, 100)");
  const tag = `pl03${label}`;
  await beginPipeline(fx, { tables: ["public.pl03_lag"], tag, maxFillMs });
  const c = await waitTablesReady(db, ["public.pl03_lag"], 300_000, 2000, ["sync_done", "ready"]);
  if (!c.ok) return { id, title, status: "fail", detail: `copy did not finish: ${JSON.stringify(c.states)}` };
  // `ready` is promoted by WAL activity after sync_done; heartbeat until it is.
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await db.q("insert into public.pl03_lag(v) values ('heartbeat')");
    const r = await waitTablesReady(db, ["public.pl03_lag"], 4000, 1000);
    ready = r.ok;
  }
  if (!ready) return { id, title, status: "fail", detail: "table never reached ready" };

  const duck = await openDuck();
  try {
    // let the destination catch up on heartbeats, and warm the DuckDB session
    for (let i = 0; i < 40; i++) {
      const [src, dst] = [await db.scalar("select max(id) from public.pl03_lag"), await duck.scalar("select max(id) from lake.public.pl03_lag")];
      if (src === dst) break;
      await sleep(1000);
    }
    const commits: Array<{ id: number; t: number }> = [];
    const polls: Array<{ t0: number; t1: number; max: number }> = [];
    let stop = false;
    const poller = (async () => {
      while (!stop || polls.length === 0) {
        const t0 = Date.now();
        const m = Number(await duck.scalar("select coalesce(max(id), 0) from lake.public.pl03_lag"));
        polls.push({ t0, t1: Date.now(), max: m });
        await sleep(100);
        if (stop && Date.now() - t0 > 20_000) break;
      }
    })();
    const tEnd = Date.now() + WINDOW_MS;
    while (Date.now() < tEnd) {
      const rows = await db.q("insert into public.pl03_lag(v) values ('probe') returning id");
      commits.push({ id: Number(rows[0]?.id), t: Date.now() });
      await sleep(800 + Math.random() * 800);
    }
    // drain: keep polling until the last row is visible or 40 s pass
    const last = commits.at(-1)?.id ?? 0;
    const tDrain = Date.now() + 40_000;
    while (Date.now() < tDrain && !polls.some((p) => p.max >= last)) await sleep(500);
    stop = true;
    await poller;

    const lags: number[] = [];
    for (const cm of commits) {
      const first = polls.find((p) => p.max >= cm.id && p.t1 >= cm.t);
      if (first) lags.push(first.t1 - cm.t);
    }
    const pollMs = polls.map((p) => p.t1 - p.t0);
    const unseen = commits.length - lags.length;
    return {
      id,
      title,
      status: unseen === 0 ? "info" : "fail",
      detail: `${lags.length} of ${commits.length} probe rows seen at the destination within the window${unseen ? `; ${unseen} never seen` : ""}`,
      measurements: {
        batch_max_fill_ms: maxFillMs ?? 10000,
        window_s: round(WINDOW_MS / 1000),
        rows_probed: commits.length,
        rows_seen: lags.length,
        lag_min_ms: round(Math.min(...lags)),
        lag_p50_ms: round(pct(lags, 50)),
        lag_p95_ms: round(pct(lags, 95)),
        lag_max_ms: round(Math.max(...lags)),
        duck_poll_p50_ms: round(pct(pollMs, 50)),
        duck_poll_p95_ms: round(pct(pollMs, 95)),
      },
    };
  } finally {
    duck.close();
  }
}

const mod: TestModule = {
  id: "PL03",
  title: "PL03 - steady replication lag",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    return [
      await one(ctx, "PL03a", "PL03a: lag with the engine default batch wait (10000 ms)", undefined, "a"),
      await one(ctx, "PL03b", "PL03b: lag with batch wait 1000 ms", 1000, "b"),
    ];
  },
};

export default withCleanup(mod);
