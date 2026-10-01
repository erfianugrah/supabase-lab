/**
 * The local-rig vantage: two throwaway Postgres 17 containers (compose.yml),
 * no managed project, no PAT. docker.exe is the only way to reach Docker
 * Desktop from this WSL distro (no native `docker` binary on PATH here) -
 * every shell-out in this file calls it explicitly rather than assuming a
 * bare `docker` works.
 */
import { $ } from "bun";
import { Client } from "pg";

export interface RigTarget {
  /** Role label used in result ids/titles. */
  role: "supabase" | "vanilla";
  /** docker container name (compose.yml container_name). */
  container: string;
  /** Published host port. */
  port: number;
  /**
   * The role that holds the CHECKPOINT privilege. A FIRST RUN of this rig
   * found `postgres` is NOT superuser on the supabase/postgres image even
   * with no init scripts run at all - it is baked into the image itself,
   * matching the managed platform's documented role split
   * (pg-analyser AGENTS.md: "only the true superuser, supabase_admin, can
   * ..."). `checkpoint` on `postgres` there throws `permission denied to
   * execute CHECKPOINT command`; `supabase_admin` (rolsuper=t, confirmed via
   * `select rolsuper from pg_roles`) can. Vanilla's `postgres` is superuser
   * as usual. Reads (pg_stat_checkpointer) are world-readable on both, so
   * only the CHECKPOINT call needs the elevated role.
   */
  checkpointRole: string;
}

export const TARGETS: RigTarget[] = [
  { role: "supabase", container: "pvlab-checkpointer-reset-supabase", port: 45432, checkpointRole: "supabase_admin" },
  { role: "vanilla", container: "pvlab-checkpointer-reset-vanilla", port: 45433, checkpointRole: "postgres" },
];

function dsn(port: number, role = "postgres"): string {
  const pw = process.env.PVLAB_LOCAL_DB_PASSWORD ?? "";
  return `postgres://${role}:${pw}@127.0.0.1:${port}/postgres`;
}

/** One query, one connection - these modules run a handful of reads each. */
export async function q(port: number, text: string, role = "postgres"): Promise<Record<string, unknown>[]> {
  const c = new Client({ connectionString: dsn(port, role), connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    const r = await c.query(text);
    return r.rows as Record<string, unknown>[];
  } finally {
    await c.end();
  }
}

/** Is a target's Postgres answering a trivial query? Used to self-skip. */
export async function rigUp(port: number): Promise<boolean> {
  try {
    await q(port, "select 1");
    return true;
  } catch {
    return false;
  }
}

/** Container running state, straight from the engine - not assumed from our own call history. */
export async function isRunning(container: string): Promise<boolean> {
  const out = await $`docker.exe inspect -f "{{.State.Running}}" ${container}`.quiet().nothrow().text();
  return out.trim() === "true";
}

/**
 * CLEAN restart: `docker.exe restart`, which sends the image's STOPSIGNAL
 * (SIGINT on both images here - verified via `docker image inspect
 * --format '{{.Config.StopSignal}}'` against both pinned tags, 2026-10-01)
 * and waits up to `timeoutS` for a graceful exit before the engine escalates
 * to SIGKILL. SIGINT is Postgres's FAST SHUTDOWN signal (docs: server
 * shutdown) - the same shutdown mode the managed restart's log line named.
 */
export async function cleanRestart(container: string, timeoutS = 30): Promise<void> {
  await $`docker.exe restart -t ${timeoutS} ${container}`.quiet();
}

/**
 * UNCLEAN restart: SIGKILL the running process, then start the (now-stopped)
 * container fresh. This is what the ad-hoc `docker restart` vs `kill -9`
 * probe used to establish the vanilla baseline this rig re-verifies on
 * reusable infra.
 */
export async function unclean_kill_then_start(container: string): Promise<void> {
  await $`docker.exe kill -s SIGKILL ${container}`.quiet();
  await $`docker.exe start ${container}`.quiet();
}

/**
 * Server log lines from `ts` onward. Postgres logs to STDERR by default, and
 * `docker logs` demuxes it there - `.text()` on a bun `$` command only reads
 * stdout, so a FIRST version of this helper that omitted `2>&1` silently
 * returned empty for every image that logs to stderr (vanilla; supabase/
 * postgres happened to also print a stdout-side `pg_ctl`-wrapper line, which
 * is what made the bug look like it was only "sometimes" there). `--since`
 * an exact instant, not a line-count tail, so two calls bracketing one
 * restart never bleed into the PREVIOUS restart's lines - a tail-depth
 * version of this did exactly that on a container already bounced once.
 */
export async function logsSince(container: string, ts: string): Promise<string> {
  return (await $`docker.exe logs --since ${ts} ${container} 2>&1`.quiet().nothrow().text()).trim();
}

/** Wait until the target answers again, or give up. Restart is not instant. */
export async function waitUp(port: number, maxWaitMs = 60_000, stepMs = 500): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await rigUp(port)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

export interface CheckpointerRow {
  num_timed: number;
  num_requested: number;
  stats_reset: string;
}

/**
 * PG17's checkpointer counters live in pg_stat_checkpointer (moved out of
 * pg_stat_bgwriter in PG17, per pg-analyser's verified version-gate note) -
 * both images here are PG17, so one query shape covers both.
 */
export async function readCheckpointer(port: number): Promise<CheckpointerRow> {
  const rows = await q(
    port,
    "select num_timed, num_requested, stats_reset::text from pg_stat_checkpointer",
  );
  const row = rows[0];
  if (!row) throw new Error("pg_stat_checkpointer returned no row");
  return row as unknown as CheckpointerRow;
}

/** A few CHECKPOINTs so num_timed/num_requested are non-zero before the restart. */
export async function runCheckpoints(port: number, role: string, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await q(port, "checkpoint", role);
}
