/**
 * MS12 - the server-side pool each pooler actually opens on Medium.
 *
 * MS01b found that neither `GET /config/database/pooler` nor
 * `/config/database/pgbouncer` returns `default_pool_size` on this project,
 * and MS09 showed connects queueing at a flat ~5.8 s from 50 clients up. The
 * pool size is what that queue is waiting on, so it is measured here from the
 * server side: N clients each run one `select pg_sleep(8)` tagged with a path
 * marker, and `pg_stat_activity` is read through the query endpoint while they
 * run. The number of concurrently active tagged backends is the pool. Rows:
 *
 *   MS12a  dedicated 6543 as `postgres`: active tagged backends at 3 s and
 *          6 s, wall time for all N to finish (about ceil(N / pool) x 8 s).
 *   MS12b  shared 6543 as `postgres.<ref>`: the same.
 *
 * N is 40 by default (PVLAB_POOL_CLIENTS). DESTRUCTIVE only in the sense of
 * holding the pool for a minute. Not settled: whether the pool grows under
 * sustained load (reserve_pool_size is 1 on the dedicated pooler per MS01b).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sql } from "../../../harness/src/platform";
import { dedicatedTarget, errText, pgClient, primaryPooler, sharedTargets, sleep, type PgTarget } from "../lib/setup";

const N = Number(process.env.PVLAB_POOL_CLIENTS ?? 40);
const SLEEP_S = 8;

async function measure(ctx: Ctx, id: string, t: PgTarget): Promise<TestResult> {
  const tag = `ms12-${t.name}-${Date.now()}`;
  const q = `select pg_sleep(${SLEEP_S}) /* ${tag} */`;
  const t0 = Date.now();
  const errors = new Map<string, number>();
  let done = 0;
  const workers = Array.from({ length: N }, async () => {
    const c = pgClient(t, ctx.dbPassword, 60_000);
    c.on("error", () => {});
    try {
      await c.connect();
      await c.query(q);
      done++;
    } catch (e) {
      const m = errText(e);
      errors.set(m, (errors.get(m) ?? 0) + 1);
    } finally {
      await c.end().catch(() => {});
    }
  });
  const samples: number[] = [];
  const sampler = (async () => {
    for (const at of [3000, 6000, 12_000, 20_000]) {
      await sleep(at - (Date.now() - t0) > 0 ? at - (Date.now() - t0) : 0);
      const r = await sql(ctx, `select count(*)::int as n from pg_stat_activity where state = 'active' and query like '%${tag}%'`);
      samples.push(Number(r.rows[0]?.n ?? -1));
    }
  })();
  await Promise.all([Promise.all(workers), sampler]);
  const wall = Date.now() - t0;
  const pool = Math.max(...samples);
  return {
    id,
    title: `${t.name} as ${t.user.startsWith("postgres.") ? "postgres.<ref>" : t.user}: active backends while ${N} clients each run pg_sleep(${SLEEP_S})`,
    status: pool > 0 ? "info" : "fail",
    detail: `max concurrently active ${pool} (samples at 3/6/12/20 s: ${samples.join("/")}); ${done}/${N} completed in ${Math.round(wall / 1000)} s${errors.size ? `; errors ${[...errors.entries()].map(([k, n]) => `${n}x ${k}`).join(" | ")}` : ""}`,
    measurements: { path: t.name, clients: N, pool_observed: pool, active_3s: samples[0] ?? "n/a", active_6s: samples[1] ?? "n/a", active_12s: samples[2] ?? "n/a", active_20s: samples[3] ?? "n/a", completed: done, wall_s: Math.round(wall / 100) / 10, expected_wall_s_if_pool: pool > 0 ? Math.ceil(N / pool) * SLEEP_S : "n/a" },
    evidence: [...errors.entries()].map(([k, n]) => `${n}x ${k}`).join("\n"),
  };
}

const mod: TestModule = {
  id: "MS12",
  title: "Effective server pool size per pooler on Medium, read from pg_stat_activity under saturation",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [await measure(ctx, "MS12a", dedicatedTarget(ctx))];
    await sleep(10_000);
    const sv = await primaryPooler(ctx);
    if (sv) out.push(await measure(ctx, "MS12b", sharedTargets(sv).txn));
    return out;
  },
};
export default mod;
