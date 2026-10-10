/**
 * The local rig for pg-minor-17-11: one throwaway supabase/postgres container
 * at a time, started from the OLD image on a fresh data directory, populated,
 * stopped with a fast shutdown, then started again from the NEW image on the
 * SAME data directory. That is the shape of a minor-version upgrade (binaries
 * replaced, data directory kept), which is what the changelog's "reindex after
 * upgrading" advice is about. It is not the hosted upgrade procedure: nothing
 * here measures what the platform does around the swap.
 *
 * The data directory lives in an anonymous volume owned by a never-started
 * "data" container, mounted into each server with --volumes-from, so that
 * `docker rm -v` on the data container removes it and no `docker volume rm`
 * is needed.
 *
 * Images are pinned by the multi-arch manifest-list digest resolved on
 * 2026-10-10 (`docker image inspect --format '{{index .RepoDigests 0}}'` after
 * `docker pull` of the tag), so a re-run measures the same builds.
 *
 * Passwords: PVLAB_LOCAL_DB_PASSWORD, written to .env (gitignored) by
 * `make local-up`. Nothing here is a real credential.
 */
import { $ } from "bun";
import { Client } from "pg";

export interface Pair {
  major: 17 | 15;
  /** Image tag before the minor (the last build of the old minor line). */
  oldTag: string;
  oldRef: string;
  /** Image tag after the minor. */
  newTag: string;
  newRef: string;
}

export const PAIRS: Pair[] = [
  {
    major: 17,
    oldTag: "17.6.1.178",
    oldRef: "supabase/postgres:17.6.1.178@sha256:c282d393ae56fd165b7ada2ddbac55e582a601b86f3840aa2bbc112e43d3a570",
    newTag: "17.11.0.004",
    newRef: "supabase/postgres:17.11.0.004@sha256:06ddc7962e11ab0f4f0334fd05671e97c30ea202f6e6a7113800bd3d6e416108",
  },
  {
    major: 15,
    oldTag: "15.14.1.178",
    oldRef: "supabase/postgres:15.14.1.178@sha256:69d8252ea850390f9def997098deb7e52429dd39d336d53833a5399e42bd1877",
    newTag: "15.19.0.004",
    newRef: "supabase/postgres:15.19.0.004@sha256:1aabcd9cfb8a58ecde50a6092b207bcbb5f6bdc45546fde35cfda5d3ab39c065",
  },
];

/** PGM_PAIRS=17 or 15 or 17,15 (default both). */
export function pairs(): Pair[] {
  const want = (process.env.PGM_PAIRS ?? "17,15").split(",").map((s) => Number(s.trim()));
  return PAIRS.filter((p) => want.includes(p.major));
}

const PORT = Number(process.env.PGM_PORT ?? "45461");
const SRV = "pvlab-pgminor-srv";
const DATA = "pvlab-pgminor-data";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function password(): string {
  return process.env.PVLAB_LOCAL_DB_PASSWORD ?? "";
}

export async function dockerOk(): Promise<boolean> {
  try {
    await $`docker info`.quiet();
    return true;
  } catch {
    return false;
  }
}

/** Pull an image reference if it is not already present. */
export async function ensureImage(ref: string): Promise<void> {
  const have = await $`docker image inspect ${ref}`.quiet().nothrow();
  if (have.exitCode !== 0) await $`docker pull ${ref}`.quiet();
}

export interface Tried {
  ok: boolean;
  rows: Record<string, unknown>[];
  /** pg error message when !ok. */
  err?: string;
  /** SQLSTATE when !ok. */
  code?: string;
}

/** Run one statement; an error is returned as data, never thrown. */
export async function tryq(c: Client, sql: string, params: unknown[] = []): Promise<Tried> {
  try {
    const r = await c.query(sql, params);
    return { ok: true, rows: (r.rows ?? []) as Record<string, unknown>[] };
  } catch (e) {
    const pe = e as { message?: string; code?: string };
    return { ok: false, rows: [], err: pe.message ?? String(e), code: pe.code };
  }
}

/** One value from the first row of a statement that must succeed. */
export async function one<T = string>(c: Client, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query(sql, params);
  return Object.values(r.rows[0] ?? {})[0] as T;
}

/** "ok" or "ERR <sqlstate>: <message>" for a statement, for flat measurement cells. */
export function outcome(t: Tried, okCell?: (rows: Record<string, unknown>[]) => string): string {
  if (t.ok) return okCell ? okCell(t.rows) : "ok";
  return `ERR ${t.code ?? "?"}: ${t.err ?? ""}`;
}

export class Rig {
  tag = "";
  constructor(readonly pair: Pair) {}

  /** Remove any leftovers of a previous run, then create the empty data directory. */
  async create(): Promise<void> {
    await this.destroy();
    await ensureImage(this.pair.oldRef);
    await ensureImage(this.pair.newRef);
    await $`docker create --name ${DATA} -v /var/lib/postgresql/data ${this.pair.oldRef} true`.quiet();
  }

  /** Start a server from `which` on the shared data directory and wait until it answers over TCP. */
  async start(which: "old" | "new"): Promise<void> {
    const ref = which === "old" ? this.pair.oldRef : this.pair.newRef;
    this.tag = which === "old" ? this.pair.oldTag : this.pair.newTag;
    const pw = password();
    await $`docker rm -f ${SRV}`.quiet().nothrow();
    // An argument array, not a multi-line template: Bun's shell treats a newline as a command separator.
    const args = [
      "run", "-d", "--name", SRV, "--volumes-from", DATA, "-p", `127.0.0.1:${PORT}:5432`,
      "-e", `POSTGRES_PASSWORD=${pw}`, "-e", "POSTGRES_HOST=/var/run/postgresql",
      "-e", "PGPORT=5432", "-e", "POSTGRES_PORT=5432", "-e", `PGPASSWORD=${pw}`,
      "-e", "PGDATABASE=postgres", "-e", "POSTGRES_DB=postgres", "-e", "JWT_EXP=3600",
      ref, "postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "log_min_messages=fatal",
    ];
    await $`docker ${args}`.quiet();
    const deadline = Date.now() + 240_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const c = await this.client("supabase_admin");
        await c.query("select 1");
        await c.end();
        // The image's init runs a temporary server first; a second clean answer
        // 2 s later means the final server is the one answering.
        await sleep(2000);
        const c2 = await this.client("supabase_admin");
        await c2.query("select 1");
        await c2.end();
        return;
      } catch (e) {
        lastErr = (e as Error).message;
        await sleep(1000);
      }
    }
    throw new Error(`server ${this.tag} did not answer within 240 s: ${lastErr}`);
  }

  /** Fast shutdown (SIGINT), wait for exit, remove the container; the data directory stays. */
  async stop(): Promise<void> {
    await $`docker kill --signal=SIGINT ${SRV}`.quiet().nothrow();
    await $`docker wait ${SRV}`.quiet().nothrow();
    await $`docker rm ${SRV}`.quiet().nothrow();
  }

  /** Remove the server and the data container together with its anonymous volume. */
  async destroy(): Promise<void> {
    await $`docker rm -f -v ${SRV}`.quiet().nothrow();
    await $`docker rm -f -v ${DATA}`.quiet().nothrow();
  }

  async client(user: "postgres" | "supabase_admin", db = "postgres"): Promise<Client> {
    const c = new Client({
      host: "127.0.0.1",
      port: PORT,
      user,
      password: password(),
      database: db,
      connectionTimeoutMillis: 10_000,
    });
    await c.connect();
    return c;
  }

  /** Run a command inside the server container; returns stdout+stderr and the exit code. */
  async exec(cmd: string[]): Promise<{ out: string; code: number }> {
    const r = await $`docker exec ${SRV} ${cmd}`.quiet().nothrow();
    return { out: (r.stdout.toString() + r.stderr.toString()).trim(), code: r.exitCode };
  }

  /** Same, with a shell (for pipes). The script text is a constant of this experiment. */
  async sh(script: string): Promise<{ out: string; code: number }> {
    return this.exec(["sh", "-c", script]);
  }

  async withClient<T>(user: "postgres" | "supabase_admin", db: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.client(user, db);
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
}

/**
 * Run `fn` against a freshly created rig for the pair and always tear it down.
 * The caller starts and stops servers itself, because each module has its own
 * old-then-new sequence.
 */
export async function withRig<T>(pair: Pair, fn: (r: Rig) => Promise<T>): Promise<T> {
  const r = new Rig(pair);
  await r.create();
  try {
    return await fn(r);
  } finally {
    await r.stop();
    await r.destroy();
  }
}

/** Compact "major.minor" of a server_version string for column names. */
export function shortVersion(v: string): string {
  return v.split(" ")[0] ?? v;
}

/** Skip reason for a module, or undefined when the rig can run. */
export async function skipReason(): Promise<string | undefined> {
  if (!(await dockerOk())) return "docker is not reachable";
  if (!password()) return "PVLAB_LOCAL_DB_PASSWORD is not set (run `make local-up` or use `make probe`)";
  return undefined;
}
