/**
 * PC08 - pgjdbc behind HikariCP on each connection path, server-side prepare
 * on (driver default) and off, plus what Hikari does when its pool is bigger
 * than the pooler's.
 *
 * Client: drivers/java/Probe.java, pgjdbc 42.7.14 and HikariCP 7.1.0 (pins and
 * sha256 in lib/java.ts), in the pinned Temurin 21 image, one container per
 * cell. An "app instance" is one HikariDataSource; a cell runs several in one
 * JVM. Each worker thread loops over: a parameterised point SELECT (which also
 * returns `pg_backend_pid()`), an `UPDATE ... RETURNING` in an explicit
 * transaction, a 5-row batch INSERT in an explicit transaction, with one
 * connection borrow per operation. Every result is checked (row id and a
 * per-statement tag), so a statement executed under another statement's name
 * shows up as a wrong result or an error, not as a silent success.
 *
 * Paths (from lib/pg.ts):
 *   direct     db.<ref>:5432, user postgres (needs the IPv4 add-on from an IPv4-only vantage)
 *   session    Supavisor <pooler host>:5432, user postgres.<ref>
 *   txn        Supavisor <pooler host>:6543, user postgres.<ref>
 *   dedicated  PgBouncer db.<ref>:6543, user postgres (add-on as for direct)
 *
 * Rows:
 *   PC08-env        project and pooler config read back (compute, max_connections,
 *                   Supavisor and PgBouncer pool settings), pgjdbc and Hikari
 *                   defaults as the loaded jars report them
 *   PC08-ipv4       IPv4 add-on: seconds to an A record (dig) and to a direct
 *                   connect from the container; skipped when already on
 *   PC08m-<path>-<arm>  shape M: 4 instances x maximumPoolSize 3, 3 workers each
 *                   (12 connections, under the session pool), every path, arms
 *                   `default` (no prepareThreshold set) and `pt0` (prepareThreshold=0)
 *   PC08m-txn-default-reuse  the txn default cell again straight after it,
 *                   without the backend reset (a redeploy onto the same backends)
 *   PC08m-txn-default-nosocktimeout  the txn default cell with pgjdbc's default
 *                   socketTimeout (0), capped at 4 minutes; reports workers
 *                   still inside an operation and for how long
 *                   (every other workload cell sets socketTimeout 30 s)
 *   PC08h-<path>-<arm>  shape H: 4 instances x maximumPoolSize 10 (Hikari's
 *                   default), 10 workers each, direct / txn / dedicated
 *   PC08q-<path>-<arm>  shape M, preferQueryMode `simple` and
 *                   `extendedCacheEverything` on txn and dedicated
 *   PC08s-*         session pooler smaller than the Hikari pool: 1 x 20 and 4 x 10
 *                   short workloads, then 1 x 20 with every worker holding
 *                   `pg_sleep(40)` (Hikari connectionTimeout left at its default)
 *   PC08t-*         transaction-mode oversubscription, 4 x 10 = 40 connections:
 *                   10 rounds of `pg_sleep(1)` each (queueing), then one
 *                   `pg_sleep(45)` each (waits past 60 s), txn and dedicated;
 *                   active sleepers read through the Management API at +10 s
 *                   (+5 s for the queue rows)
 *
 * Before every cell the module terminates the backends left by the previous
 * cell (application_name `Supavisor` or the probe's own) through the
 * Management API, so a cell does not inherit another cell's named statements.
 * After the last cell each cell's window is matched against Postgres's own log
 * (`pg_log_*` columns): what the server refused, whatever the client saw.
 * Iterations per worker: PVLAB_PC08_ITER (default 500). Phases:
 * PVLAB_PC08_PHASES (default `matrix,heavy,modes,session,txn`); cells:
 * PVLAB_PC08_CELLS (regex on ids); wall cap per workload cell:
 * PVLAB_PC08_MAX_WALL_S (default 480).
 * PVLAB_PC08_KEEP_IPV4=1 leaves an add-on this module switched on in place.
 *
 * Not settled by this module: other pgjdbc or Hikari versions, other compute
 * sizes and regions, Hikari's validation of idle connections while the
 * transaction pool is saturated (connections here are reused within its
 * 500 ms bypass window), `autosave`, `reWriteBatchedInserts`, long-lived
 * pools across a pooler restart, an in-region client.
 */
import { $ } from "bun";
import { mgmt } from "../../../harness/src/mgmt";
import { logsQuery, sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { ensureImage, ensureJars, flatten, JARS, JDK_IMAGE, runJava, stderrKinds, type JavaRun } from "../lib/java";
import { activeSleepers, dedicated, direct, sharedSession, sharedTxn, type Target } from "../lib/pg";
import { acquireProject, sleep, stallGuard, type PcProject } from "../lib/project";

const ITER = Number(process.env.PVLAB_PC08_ITER ?? 500);
const PHASES = new Set((process.env.PVLAB_PC08_PHASES ?? "matrix,heavy,modes,session,txn").split(","));
const KEEP_IPV4 = process.env.PVLAB_PC08_KEEP_IPV4 === "1";
/** Optional regex on cell ids: cells that do not match are not run (and leave no row). */
const CELLS = process.env.PVLAB_PC08_CELLS ? new RegExp(process.env.PVLAB_PC08_CELLS) : null;
/** Wall cap for workload cells, seconds (default 480). */
const MAX_WALL_MS = Number(process.env.PVLAB_PC08_MAX_WALL_S ?? 480) * 1000;
const RAW = process.env.PVLAB_PC_RAW_DIR ? `${process.env.PVLAB_PC_RAW_DIR}/pc08-raw` : undefined;
/**
 * pgjdbc's socketTimeout for workload cells. The driver default is 0 (wait for ever); in the
 * 2026-11-04 smoke run five Supavisor transaction-mode workers waited more than 280 s for a reply
 * that never came, which would park a cell until its wall cap. 30 s turns such a wait into a
 * counted 08006 error. PC08m-txn-default-nosocktimeout keeps the default to record the wait itself.
 */
const WORKLOAD_SOCKET_TIMEOUT_S = process.env.PVLAB_PC08_SOCKET_TIMEOUT_S ?? "30";

type PathName = "direct" | "session" | "txn" | "dedicated";
type Arm = "default" | "pt0" | "simple" | "cacheall";
interface Shape {
  instances: number;
  pool: number;
  workers: number;
}
const M: Shape = { instances: 4, pool: 3, workers: 3 };
const H: Shape = { instances: 4, pool: 10, workers: 10 };

const armEnv = (a: Arm): Record<string, string> =>
  a === "pt0" ? { PREPARE_THRESHOLD: "0" } : a === "simple" ? { QUERY_MODE: "simple" } : a === "cacheall" ? { QUERY_MODE: "extendedCacheEverything" } : {};

function target(p: PcProject, path: PathName): Target {
  return path === "direct" ? direct(p) : path === "session" ? sharedSession(p) : path === "txn" ? sharedTxn(p) : dedicated(p);
}

function connEnv(p: PcProject, t: Target): Record<string, string> {
  return { PGHOST: t.host, PGPORT: String(t.port), PGUSER: t.user, PGPASSWORD: p.password, PGDATABASE: "postgres" };
}

/** Management API calls share a PAT with other users: back off on 429 and the HTML throttle page. */
async function politeMgmt(ctx: Ctx, method: string, path: string, body?: unknown) {
  let r = await mgmt(ctx, method, path, body);
  for (let a = 0; (r.status === 429 || r.throttled) && a < 6; a++) {
    const m = /try again in (\d+)/.exec(r.text);
    await sleep(m ? Number(m[1]) * 60_000 + 5000 : 15_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

async function politeSql(ctx: Ctx, query: string) {
  let r = await sql(ctx, query);
  for (let a = 0; r.status === 429 && a < 6; a++) {
    await sleep(15_000);
    r = await sql(ctx, query);
  }
  return r;
}

/** Terminate the backends a previous cell left: Supavisor's own and the probe's (direct and PgBouncer server connections carry it). */
async function resetBackends(p: PcProject): Promise<number | string> {
  const r = await politeSql(
    p.ctx,
    "select count(*)::int n from (select pg_terminate_backend(pid) from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() and application_name in ('Supavisor', 'pc08-probe')) t",
  );
  await sleep(3000);
  return r.error ? `error: ${r.error.slice(0, 120)}` : Number(r.rows[0]?.n ?? 0);
}

let cellNo = 0;
const cellName = (id: string) => `pc08-${String(++cellNo).padStart(2, "0")}-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

function rowFromRun(id: string, title: string, run: JavaRun, extra: Record<string, number | string>): TestResult {
  const s = run.summary;
  if (!s) {
    return {
      id,
      title,
      status: "fail",
      detail: `no summary from the probe (exit ${run.exitCode}${run.timedOut ? ", killed at the module deadline" : ""}): ${run.stderr.replace(/\s+/g, " ").slice(-300)}`,
      measurements: { ...extra, exit_code: run.exitCode, timed_out: run.timedOut ? "yes" : "no", host_drift_ms: run.hostDriftMs },
    };
  }
  const f = flatten(s);
  const sk = stderrKinds(run.stderr);
  const failed = Number(f.iteration_fail ?? 0) + Number(f.hold_borrow_fail ?? 0) + Number(f.hold_exec_fail ?? 0) + Number(f.followup_fail ?? 0);
  const wrong = Number(f.wrong_results ?? 0);
  const clean = failed === 0 && wrong === 0 && Number(f.pool_init_errors) === 0 && Number(f.threads_alive_at_end) === 0;
  const head =
    "iteration_ok" in f
      ? `${f.iteration_ok} of ${Number(f.iteration_ok) + Number(f.iteration_fail)} iterations ok, ${wrong} wrong results, ${f.throughput_iter_per_s} it/s, iteration p50/p95/p99 ${f.iteration_p50_ms ?? "-"}/${f.iteration_p95_ms ?? "-"}/${f.iteration_p99_ms ?? "-"} ms, backend switches ${f.backend_switches} over ${f.backend_pid_samples} selects`
      : `hold ok ${f.hold_exec_ok ?? 0}, hold failed ${f.hold_exec_fail ?? 0}, borrow failed ${f.hold_borrow_fail ?? 0}, follow-up ok ${f.followup_ok ?? 0} failed ${f.followup_fail ?? 0}`;
  return {
    id,
    title,
    status: clean ? "pass" : "info",
    detail: `${head}; first error at ${f.first_error_ms} ms; ${f.threads_alive_at_end} workers still inside an operation at the end (${f.threads_alive}); errors: ${f.errors_top}`,
    measurements: {
      ...extra,
      ...f,
      hikari_warn_lines: sk.warn_lines,
      hikari_warn_top: sk.top,
      host_drift_ms: run.hostDriftMs,
      exit_code: run.exitCode,
    },
    evidence: JSON.stringify({ errors: s.errors, wrong_examples: s.wrong_examples, threads_alive: s.threads_alive, pools: s.pools, hikari_effective: (s.config as Record<string, unknown> | undefined)?.hikari_effective }, null, 1).slice(0, 14_000),
  };
}

interface CellOpts {
  /** terminate the previous cell's backends first (default true) */
  reset?: boolean;
  /** pgjdbc socketTimeout in seconds; "" = the driver default (0) */
  socketTimeoutS?: string;
  maxWallMs?: number;
}

/** Cell windows for the Postgres log tally at the end of the module. */
const windows: { row: TestResult; t0: string; t1: string }[] = [];

async function workloadCell(p: PcProject, id: string, path: PathName, arm: Arm, shape: Shape, iterations: number, ctx: Ctx, o: CellOpts = {}): Promise<TestResult | null> {
  if (CELLS && !CELLS.test(id)) return null;
  const t = target(p, path);
  const terminated = o.reset === false ? "not reset" : await resetBackends(p);
  const maxWall = o.maxWallMs ?? MAX_WALL_MS;
  const sock = o.socketTimeoutS ?? WORKLOAD_SOCKET_TIMEOUT_S;
  ctx.log(`${id}: ${path} ${arm} ${shape.instances}x${shape.pool} (${shape.workers} workers each), ${iterations} iterations, socketTimeout ${sock || "default"}`);
  const t0 = new Date().toISOString();
  const run = await runJava(
    cellName(id),
    {
      ...connEnv(p, t),
      ...armEnv(arm),
      MODE: "workload",
      INSTANCES: String(shape.instances),
      POOL_SIZE: String(shape.pool),
      WORKERS: String(shape.workers),
      ITERATIONS: String(iterations),
      MAX_WALL_MS: String(maxWall),
      ...(sock ? { SOCKET_TIMEOUT_S: sock } : {}),
    },
    { timeoutMs: maxWall + 90_000, rawDir: RAW },
  );
  const cfg = (run.config ?? {}) as Record<string, unknown>;
  const row = rowFromRun(
    id,
    `${id}: ${t.label}, ${arm}, ${shape.instances} instances x maximumPoolSize ${shape.pool}, ${shape.workers} workers each, ${iterations} iterations per worker, socketTimeout ${sock ? sock + " s" : "driver default"}${o.reset === false ? ", previous cell's backends kept" : ""}`,
    run,
    {
      path: t.label,
      arm,
      prepare_threshold: String(cfg.prepareThreshold_effective ?? "?"),
      query_mode: String(cfg.preferQueryMode_effective ?? "?"),
      socket_timeout_s: String(cfg.socketTimeout_s_effective ?? "?"),
      instances: shape.instances,
      pool_size: shape.pool,
      workers_total: shape.instances * shape.workers,
      iterations_per_worker: iterations,
      backends_terminated_before: terminated,
      cell_start_utc: t0,
    },
  );
  windows.push({ row, t0, t1: new Date().toISOString() });
  return row;
}

async function holdCell(
  p: PcProject,
  id: string,
  title: string,
  path: PathName,
  shape: Shape,
  holdSql: string,
  repeat: number,
  maxWallMs: number,
  ctx: Ctx,
  sampleAtMs = 10_000,
): Promise<TestResult | null> {
  if (CELLS && !CELLS.test(id)) return null;
  const t = target(p, path);
  const terminated = await resetBackends(p);
  ctx.log(`${id}: ${path} ${shape.instances}x${shape.pool}, ${holdSql} x${repeat}`);
  let sampled: Promise<{ active: number; idle: number; error: string }> | undefined;
  const t0 = new Date().toISOString();
  const run = await runJava(
    cellName(id),
    {
      ...connEnv(p, t),
      MODE: "hold",
      INSTANCES: String(shape.instances),
      POOL_SIZE: String(shape.pool),
      WORKERS: String(shape.workers),
      HOLD_SQL: holdSql,
      HOLD_REPEAT: String(repeat),
      MAX_WALL_MS: String(maxWallMs),
    },
    {
      timeoutMs: maxWallMs + 90_000,
      rawDir: RAW,
      onLine: (o) => {
        if (o.e === "start") sampled = sleep(sampleAtMs).then(() => activeSleepers(p.ctx));
      },
    },
  );
  const act = sampled ? await sampled : { active: -1, idle: -1, error: "no start line" };
  const row = rowFromRun(id, `${id}: ${title}`, run, {
    path: t.label,
    instances: shape.instances,
    pool_size: shape.pool,
    workers_total: shape.instances * shape.workers,
    hold_sql: holdSql,
    hold_repeat: repeat,
    active_sleepers_sampled: act.error ? `error: ${act.error.slice(0, 80)}` : act.active,
    active_sleepers_sampled_at_ms: sampleAtMs,
    backends_terminated_before: terminated,
    cell_start_utc: t0,
  });
  windows.push({ row, t0, t1: new Date().toISOString() });
  return row;
}

/**
 * Postgres's own log lines per cell window (Management API logs endpoint, ClickHouse SQL;
 * 10 requests per 60 s, so one query every 7 s). Connection, disconnection and checkpoint lines
 * are left out; digits are folded so `S_17` and `S_3` count as one message.
 */
async function tallyLogs(ctx: Ctx, p: PcProject): Promise<void> {
  const ch = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
  for (const w of windows) {
    const q =
      `select replaceRegexpAll(event_message, '[0-9]+', 'N') as m, count(*) as n from logs where source = 'postgres_logs' ` +
      `and timestamp >= toDateTime64('${ch(w.t0)}', 6) and timestamp < toDateTime64('${ch(w.t1)}', 6) ` +
      `and event_message not like 'connection %' and event_message not like 'disconnection%' and event_message not like 'checkpoint%' ` +
      `group by m order by n desc limit 8`;
    let r = await logsQuery(p.ctx, q, 4);
    for (let a = 0; (r.status === 429 || r.status >= 500) && a < 3; a++) {
      await sleep(20_000);
      r = await logsQuery(p.ctx, q, 4);
    }
    const rows = r.rows.map((x) => ({ m: String(x.m ?? ""), n: Number(x.n ?? 0) }));
    const m = (w.row.measurements ??= {});
    m.pg_log_status = r.error ? `${r.status} ${r.error.slice(0, 80)}` : r.status;
    m.pg_log_lines = rows.reduce((a, x) => a + x.n, 0);
    m.pg_log_prepared_or_bind = rows.filter((x) => /prepared statement|bind message/.test(x.m)).reduce((a, x) => a + x.n, 0);
    m.pg_log_top = rows.slice(0, 5).map((x) => `${x.n}x ${x.m.slice(0, 110)}`).join(" | ") || "none";
    ctx.log(`${w.row.id}: postgres log ${m.pg_log_lines} lines`);
    await sleep(7000);
  }
}

async function addonSelected(ctx: Ctx): Promise<{ selected: string[]; available: string[] }> {
  const r = await politeMgmt(ctx, "GET", `/projects/${ctx.ref}/billing/addons`);
  const j = (r.json ?? {}) as { selected_addons?: { type: string }[]; available_addons?: { type: string }[] };
  return { selected: (j.selected_addons ?? []).map((a) => a.type), available: (j.available_addons ?? []).map((a) => a.type) };
}

async function digA(host: string): Promise<boolean> {
  const r = await $`dig +short A ${host}`.quiet().nothrow();
  return /\d+\.\d+\.\d+\.\d+/.test(r.stdout.toString());
}

const mod: TestModule = {
  id: "PC08",
  title: "pgjdbc + HikariCP on direct, Supavisor session/transaction and the dedicated pooler: server-side prepare on and off, oversize pools",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC08", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const all: (TestResult | null)[] = [];
    const out = { push: (...r: (TestResult | null)[]) => all.push(...r) };
    const done = () => all.filter((r): r is TestResult => r !== null);
    const guard = stallGuard("PC08");
    const jarErr = await ensureJars();
    const imgErr = jarErr ? "" : await ensureImage();
    if (jarErr || imgErr) return [{ id: "PC08", title: this.title, status: "fail", detail: `java toolchain: ${jarErr || imgErr}` }];
    const p = await acquireProject(ctx);

    // ---- PC08-env
    const facts = await politeSql(
      p.ctx,
      "select current_setting('max_connections') mc, current_setting('server_version') sv, (select count(*)::int from pg_stat_activity) backends",
    );
    const pgb = await politeMgmt(ctx, "GET", `/projects/${p.ref}/config/database/pgbouncer`);
    const pj = (pgb.json ?? {}) as Record<string, unknown>;
    const defaults = await runJava(cellName("defaults"), { MODE: "defaults" }, { timeoutMs: 120_000, rawDir: RAW });
    const d = (defaults.config ?? {}) as Record<string, unknown>;
    out.push({
      id: "PC08-env",
      title: "PC08-env: project, pooler settings read back, driver and pool defaults as loaded",
      status: facts.error || !defaults.config ? "fail" : "info",
      detail: `${p.instanceSize}, ${p.region}, max_connections ${facts.rows[0]?.mc}, Postgres ${facts.rows[0]?.sv}; Supavisor default_pool_size ${p.poolerEntry.default_pool_size ?? "null"}, max_client_conn ${p.poolerEntry.max_client_conn ?? "null"}; PgBouncer HTTP ${pgb.status} default_pool_size ${pj.default_pool_size ?? "-"}, max_client_conn ${pj.max_client_conn ?? "-"}, query_wait_timeout ${pj.query_wait_timeout ?? "-"}; pgjdbc ${d.pgjdbc_version} default prepareThreshold ${d.pgjdbc_default_prepareThreshold}; Hikari ${d.hikari_version}`,
      measurements: {
        compute: p.instanceSize,
        region: p.region,
        max_connections: String(facts.rows[0]?.mc ?? "?"),
        server_version: String(facts.rows[0]?.sv ?? "?"),
        backends_idle_project: Number(facts.rows[0]?.backends ?? -1),
        supavisor_default_pool_size: p.poolerEntry.default_pool_size ?? "null",
        supavisor_max_client_conn: p.poolerEntry.max_client_conn ?? "null",
        supavisor_pool_mode: p.poolerEntry.pool_mode ?? "null",
        pgbouncer_config_status: pgb.status,
        pgbouncer_default_pool_size: String(pj.default_pool_size ?? "-"),
        pgbouncer_max_client_conn: String(pj.max_client_conn ?? "-"),
        pgbouncer_pool_mode: String(pj.pool_mode ?? "-"),
        pgbouncer_query_wait_timeout: String(pj.query_wait_timeout ?? "-"),
        pgbouncer_reserve_pool_size: String(pj.reserve_pool_size ?? "-"),
        pgbouncer_ignore_startup_parameters: String(pj.ignore_startup_parameters ?? "-"),
        pgjdbc_version: String(d.pgjdbc_version ?? "?"),
        pgjdbc_default_prepareThreshold: String(d.pgjdbc_default_prepareThreshold ?? "?"),
        pgjdbc_default_preferQueryMode: String(d.pgjdbc_default_preferQueryMode ?? "?"),
        hikari_version: String(d.hikari_version ?? "?"),
        hikari_default_maximumPoolSize: String(d.hikari_default_maximumPoolSize ?? "?"),
        hikari_default_connectionTimeout_ms: String(d.hikari_default_connectionTimeout_ms ?? "?"),
        hikari_default_validationTimeout_ms: String(d.hikari_default_validationTimeout_ms ?? "?"),
        hikari_default_maxLifetime_ms: String(d.hikari_default_maxLifetime_ms ?? "?"),
        hikari_default_keepaliveTime_ms: String(d.hikari_default_keepaliveTime_ms ?? "?"),
        hikari_default_initializationFailTimeout_ms: String(d.hikari_default_initializationFailTimeout_ms ?? "?"),
        java_version: String(d.java_version ?? "?"),
        jdk_image: JDK_IMAGE.replace(/@sha256:(.{12}).*/, "@sha256:$1"),
        jars: JARS.map((j) => j.path.split("/").at(-1)).join(" "),
        iterations_per_worker: ITER,
      },
      evidence: facts.error || undefined,
    });

    // ---- schema, written through the Management API (not through any path under test)
    const schema = await politeSql(
      p.ctx,
      `drop table if exists pc08_items, pc08_events;
       create table pc08_items (id bigint primary key, k int not null default 0, v text);
       insert into pc08_items select g, 0, 'x' from generate_series(1, 10000) g;
       create table pc08_events (id bigserial primary key, item_id bigint not null, note text not null, at timestamptz not null default now());`,
    );
    if (schema.error) {
      out.push({ id: "PC08-schema", title: "PC08: schema", status: "fail", detail: schema.error });
      out.push(guard.result());
      return done();
    }

    // ---- IPv4 add-on for direct and dedicated
    let addonOn = false;
    let weEnabled = false;
    const ad = await addonSelected(p.ctx);
    const dirT = direct(p);
    const ping = async (t: Target) => runJava(cellName("ping"), { ...connEnv(p, t), MODE: "ping" }, { timeoutMs: 60_000 });
    if (ad.selected.includes("ipv4")) {
      addonOn = true;
      const pr = await ping(dirT);
      out.push({
        id: "PC08-ipv4",
        title: "PC08-ipv4: IPv4 add-on already selected at module start",
        status: pr.exitCode === 0 ? "info" : "fail",
        detail: `direct ping from the container: ${JSON.stringify(pr.lines.find((l) => l.e === "ping") ?? {}).slice(0, 200)}`,
        measurements: { addon_at_start: "selected", direct_ping_ok: pr.exitCode === 0 ? "yes" : "no" },
      });
    } else if (ad.available.includes("ipv4")) {
      const tOn = Date.now();
      const patch = await politeMgmt(p.ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "ipv4", addon_variant: "ipv4_default" });
      weEnabled = patch.status < 300;
      let tA: number | null = null;
      let tPing: number | null = null;
      let lastPing = "";
      while (weEnabled && Date.now() - tOn < 15 * 60_000 && tPing === null) {
        await sleep(10_000);
        if (tA === null && (await digA(dirT.host))) tA = Date.now() - tOn;
        if (tA !== null) {
          const pr = await ping(dirT);
          if (pr.exitCode === 0) tPing = Date.now() - tOn;
          else lastPing = String((pr.lines.find((l) => l.e === "ping") as { error?: string } | undefined)?.error ?? pr.stderr.slice(-160));
        }
      }
      addonOn = tPing !== null;
      out.push({
        id: "PC08-ipv4",
        title: "PC08-ipv4: IPv4 add-on switched on - seconds to an A record (dig, host) and to a direct connect from the container (poll step 10 s)",
        status: addonOn ? "info" : "fail",
        detail: `PATCH HTTP ${patch.status}; A record after ${tA === null ? "never" : Math.round(tA / 1000) + " s"}; container direct connect after ${tPing === null ? "never (" + lastPing.slice(0, 160) + ")" : Math.round(tPing / 1000) + " s"}`,
        measurements: {
          patch_status: patch.status,
          ipv4_a_record_s: tA === null ? "never" : Math.round(tA / 1000),
          container_direct_connect_s: tPing === null ? "never" : Math.round(tPing / 1000),
        },
      });
    } else {
      out.push({ id: "PC08-ipv4", title: "PC08-ipv4: IPv4 add-on", status: "skip", detail: `ipv4 not in available_addons [${ad.available.join(",")}]` });
    }
    const reachable = (path: PathName) => addonOn || path === "session" || path === "txn";
    const skipRow = (id: string): TestResult => ({ id, title: id, status: "skip", detail: "direct and dedicated need the IPv4 add-on from this IPv4-only vantage; it was not reachable" });

    try {
      if (PHASES.has("matrix")) {
        for (const path of ["direct", "session", "txn", "dedicated"] as PathName[])
          for (const arm of ["default", "pt0"] as Arm[]) {
            const id = `PC08m-${path}-${arm}`;
            out.push(reachable(path) ? await workloadCell(p, id, path, arm, M, ITER, ctx) : skipRow(id));
            if (path === "txn" && arm === "default") {
              // A second app generation on the backends the first one left (no reset): a redeploy.
              out.push(await workloadCell(p, "PC08m-txn-default-reuse", "txn", "default", M, ITER, ctx, { reset: false }));
              // The same cell with pgjdbc's default socketTimeout (0), capped at 4 minutes: does anything wait for ever?
              out.push(await workloadCell(p, "PC08m-txn-default-nosocktimeout", "txn", "default", M, ITER, ctx, { socketTimeoutS: "", maxWallMs: 4 * 60_000 }));
            }
          }
      }
      if (PHASES.has("heavy")) {
        for (const path of ["direct", "txn", "dedicated"] as PathName[])
          for (const arm of ["default", "pt0"] as Arm[]) {
            const id = `PC08h-${path}-${arm}`;
            out.push(reachable(path) ? await workloadCell(p, id, path, arm, H, ITER, ctx) : skipRow(id));
          }
      }
      if (PHASES.has("modes")) {
        for (const path of ["txn", "dedicated"] as PathName[])
          for (const arm of ["simple", "cacheall"] as Arm[]) {
            const id = `PC08q-${path}-${arm}`;
            out.push(reachable(path) ? await workloadCell(p, id, path, arm, M, ITER, ctx) : skipRow(id));
          }
      }
      if (PHASES.has("session")) {
        const short = Math.min(ITER, 100);
        out.push(await workloadCell(p, "PC08s-1x20", "session", "default", { instances: 1, pool: 20, workers: 20 }, short, ctx));
        out.push(await workloadCell(p, "PC08s-4x10", "session", "default", { instances: 4, pool: 10, workers: 10 }, short, ctx));
        out.push(
          await holdCell(
            p,
            "PC08s-hold",
            "Supavisor session 5432, 1 instance x maximumPoolSize 20, 20 workers each borrow once and run pg_sleep(40), then a follow-up select 1",
            "session",
            { instances: 1, pool: 20, workers: 20 },
            "select pg_sleep(40)",
            1,
            150_000,
            ctx,
          ),
        );
      }
      if (PHASES.has("txn")) {
        for (const path of ["txn", "dedicated"] as PathName[]) {
          if (!reachable(path)) {
            out.push(skipRow(`PC08t-${path}-queue`), skipRow(`PC08t-${path}-wait`));
            continue;
          }
          out.push(
            await holdCell(
              p,
              `PC08t-${path}-queue`,
              `${target(p, path).label}, 4 instances x maximumPoolSize 10, 40 workers x 10 rounds of pg_sleep(1)`,
              path,
              H,
              "select pg_sleep(1)",
              10,
              180_000,
              ctx,
              5000,
            ),
          );
          out.push(
            await holdCell(
              p,
              `PC08t-${path}-wait`,
              `${target(p, path).label}, 4 instances x maximumPoolSize 10, 40 workers x one pg_sleep(45), then a follow-up select 1`,
              path,
              H,
              "select pg_sleep(45)",
              1,
              240_000,
              ctx,
            ),
          );
        }
      }
    } finally {
      if (weEnabled && !KEEP_IPV4) {
        let del = await politeMgmt(p.ctx, "DELETE", `/projects/${p.ref}/billing/addons/ipv4_default`);
        for (let a = 0; del.status === 429 && a < 5; a++) {
          const m = /try again in (\d+)/.exec(del.text);
          await sleep((m ? Number(m[1]) : 1) * 60_000 + 5000);
          del = await politeMgmt(p.ctx, "DELETE", `/projects/${p.ref}/billing/addons/ipv4_default`);
        }
        out.push({ id: "PC08-ipv4-off", title: "PC08: IPv4 add-on removed", status: del.status < 300 ? "info" : "fail", detail: `DELETE HTTP ${del.status}`, measurements: { delete_status: del.status } });
      }
    }
    if (windows.length) {
      ctx.log(`postgres log tally for ${windows.length} cells (after a 60 s ingestion wait)`);
      await sleep(60_000);
      await tallyLogs(ctx, p);
    }
    out.push(guard.result());
    return done();
  },
};

export default mod;
