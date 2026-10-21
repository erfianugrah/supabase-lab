/**
 * Local Docker rig for OrioleDB's experimental S3 mode: one S3 server (RustFS)
 * and OrioleDB containers on a private network. Everything is named `ws3-*`
 * so `make clean` removes exactly this rig.
 *
 * The S3 credentials are throwaway values for a container that listens only
 * on the private Docker network; they are not secrets.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ORIOLE_IMAGE = process.env.WS_ORIOLE_IMAGE ?? "orioledb/orioledb:beta19-pg17";
export const S3_IMAGE = process.env.WS_S3_IMAGE ?? "rustfs/rustfs:1.0.3";
export const AWS_IMAGE = "amazon/aws-cli:latest";
export const NET = "ws3";
export const S3_NAME = "ws3-s3";
export const S3_KEY = "ws3admin";
export const S3_SECRET = "ws3secret123";
export const REGION = "us-east-1";
/** The S3 loader is fetched at the OrioleDB tag the image was built from. */
export const LOADER_TAG = process.env.WS_LOADER_TAG ?? "beta19";
export const LOADER_URL = `https://raw.githubusercontent.com/orioledb/orioledb/${LOADER_TAG}/orioledb_s3_loader.py`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Out {
  code: number;
  out: string;
  err: string;
}

export async function sh(cmd: string[], stdin?: string): Promise<Out> {
  const p = Bun.spawn(cmd, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

export async function docker(...args: string[]): Promise<Out> {
  return sh(["docker", ...args]);
}

/** psql inside a container, unaligned tuples-only; one statement per -c. */
export async function psql(container: string, ...stmts: string[]): Promise<Out> {
  return docker("exec", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-Atq", ...stmts.flatMap((s) => ["-c", s]));
}

export async function q1(container: string, sql: string): Promise<string> {
  const r = await psql(container, sql);
  if (r.code !== 0) throw new Error(`${sql.slice(0, 60)}: ${r.err.trim().slice(0, 200)}`);
  return r.out.trim();
}

/** Milliseconds for one statement run inside the container (psql \timing). */
export async function timedSql(container: string, sql: string): Promise<{ ms: number; out: string; err: string }> {
  const r = await docker("exec", container, "psql", "-U", "postgres", "-Atq", "-c", "\\timing on", "-c", sql);
  const m = /Time: ([0-9.]+) ms/.exec(r.out + r.err);
  return { ms: m ? Number(m[1]) : -1, out: r.out.replace(/Time: .*$/m, "").trim(), err: r.err.trim() };
}

export async function rmContainer(name: string): Promise<void> {
  await docker("rm", "-f", "-v", name);
}

export async function ensureNet(): Promise<void> {
  await docker("network", "create", NET);
}

export async function aws(...args: string[]): Promise<Out> {
  return docker(
    "run", "--rm", "--network", NET,
    "-e", `AWS_ACCESS_KEY_ID=${S3_KEY}`, "-e", `AWS_SECRET_ACCESS_KEY=${S3_SECRET}`, "-e", `AWS_DEFAULT_REGION=${REGION}`,
    AWS_IMAGE, "--endpoint-url", `http://${S3_NAME}:9000`, ...args,
  );
}

/** A fresh S3 server with one empty bucket. */
export async function freshS3(bucket: string): Promise<void> {
  await ensureNet();
  await rmContainer(S3_NAME);
  const r = await docker("run", "-d", "--name", S3_NAME, "--network", NET, "-e", `RUSTFS_ACCESS_KEY=${S3_KEY}`, "-e", `RUSTFS_SECRET_KEY=${S3_SECRET}`, S3_IMAGE, "/data");
  if (r.code !== 0) throw new Error(`s3 start: ${r.err}`);
  for (let i = 0; i < 30; i++) {
    const mb = await aws("s3", "mb", `s3://${bucket}`);
    if (mb.code === 0) return;
    await sleep(1000);
  }
  throw new Error("s3 bucket never created");
}

export interface Listing {
  objects: number;
  bytes: number;
  byPrefix: Record<string, { n: number; bytes: number }>;
  keys: string[];
}

export async function listBucket(bucket: string): Promise<Listing> {
  const r = await aws("s3", "ls", `s3://${bucket}`, "--recursive");
  const lines = r.out.split("\n").filter((l) => l.trim());
  const out: Listing = { objects: 0, bytes: 0, byPrefix: {}, keys: [] };
  for (const l of lines) {
    const parts = l.trim().split(/\s+/);
    const size = Number(parts[2] ?? 0);
    const key = parts.slice(3).join(" ");
    out.objects++;
    out.bytes += size;
    out.keys.push(key);
    const pre = key.split("/")[0] ?? "";
    out.byPrefix[pre] ??= { n: 0, bytes: 0 };
    out.byPrefix[pre].n++;
    out.byPrefix[pre].bytes += size;
  }
  return out;
}

/** Highest checkpoint directory number under data/ and orioledb_data/. */
export function lastCheckpoint(l: Listing): number {
  let max = 0;
  for (const k of l.keys) {
    const m = /^(?:data|orioledb_data)\/(\d+)\//.exec(k);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export function s3Flags(bucket: string, extra: Record<string, string> = {}): string[] {
  const conf: Record<string, string> = {
    shared_preload_libraries: "orioledb",
    "orioledb.s3_mode": "on",
    archive_mode: "on",
    archive_library: "orioledb",
    "orioledb.s3_host": `${S3_NAME}:9000`,
    "orioledb.s3_region": REGION,
    "orioledb.s3_prefix": bucket,
    "orioledb.s3_use_https": "off",
    "orioledb.s3_accesskey": S3_KEY,
    "orioledb.s3_secretkey": S3_SECRET,
    "orioledb.s3_num_workers": "4",
    max_worker_processes: "16",
    ...extra,
  };
  return Object.entries(conf).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
}

/**
 * Start an OrioleDB container. With `volume`, PGDATA lives on that named
 * volume (so a restored data directory can be started); without, it lives in
 * the container layer and `rmContainer` destroys it.
 */
export async function startPg(name: string, flags: string[], volume?: string): Promise<void> {
  await rmContainer(name);
  const args = ["run", "-d", "--name", name, "--network", NET, "-e", "POSTGRES_PASSWORD=ws3", "-e", "PGDATA=/var/lib/postgresql/data/pgdata"];
  if (volume) args.push("-v", `${volume}:/var/lib/postgresql/data`);
  const r = await docker(...args, ORIOLE_IMAGE, "postgres", ...flags);
  if (r.code !== 0) throw new Error(`pg start ${name}: ${r.err}`);
  await waitReady(name);
}

export async function waitReady(name: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now();
  // The image's entrypoint runs initdb and a temporary server first; wait for
  // the final server, then for a query to succeed.
  while (Date.now() - t0 < timeoutMs) {
    const logs = await docker("logs", name);
    const ready = (logs.out + logs.err).match(/database system is ready to accept connections/g)?.length ?? 0;
    const initRan = /PostgreSQL init process complete/.test(logs.out + logs.err);
    if ((initRan && ready >= 2) || (!initRan && ready >= 1)) {
      const r = await psql(name, "select 1");
      if (r.code === 0) return;
    }
    const st = await docker("inspect", "-f", "{{.State.Running}}", name);
    if (st.out.trim() === "false") throw new Error(`${name} exited: ${(logs.out + logs.err).slice(-600)}`);
    await sleep(1000);
  }
  throw new Error(`${name} not ready in ${timeoutMs} ms`);
}

/** The loader script, fetched once into evidence/ (gitignored; third-party). */
export async function loaderPath(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = resolve(join(dir, `orioledb_s3_loader-${LOADER_TAG}.py`));
  if (!existsSync(p)) {
    const r = await fetch(LOADER_URL);
    if (!r.ok) throw new Error(`loader fetch ${r.status}`);
    writeFileSync(p, await r.text());
  }
  return p;
}

/**
 * A copy of the loader with the one-line fix for iterating a dict without
 * .items() in download_unchanged_small_files (upstream PR #1271, closed
 * unmerged). Labelled "patched" wherever it is used.
 */
export async function patchedLoaderPath(dir: string): Promise<string> {
  const src = await loaderPath(dir);
  const p = src.replace(/\.py$/, "-patched.py");
  const text = await Bun.file(src).text();
  const fixed = text.replace("for filename, checkpoint in file_checksums:", "for filename, checkpoint in file_checksums.items():");
  if (fixed === text) throw new Error("loader patch target not found");
  writeFileSync(p, fixed);
  return p;
}

/**
 * Restore the bucket's last checkpoint into a new named volume with the
 * upstream loader, run inside the OrioleDB image (it needs pg_controldata).
 */
export async function restoreInto(volume: string, bucket: string, loader: string, adoptLock = false): Promise<Out> {
  // A stopped container still holding the volume makes `volume rm` fail
  // silently and the restore lands on top of old files (it did, 2026-10-21).
  const users = (await docker("ps", "-aq", "--filter", `volume=${volume}`)).out.split("\n").filter(Boolean);
  for (const id of users) await docker("rm", "-f", id);
  if (!volume.startsWith("ws3-")) throw new Error(`refusing to recreate volume ${volume}: not a ws3- rig volume`);
  await docker("volume", "rm", "-f", volume);
  await docker("volume", "create", volume);
  const script = [
    "set -e",
    "apk add --no-cache python3 py3-boto3 py3-pip >/dev/null",
    "pip install --quiet --break-system-packages testgres >/dev/null 2>&1",
    "mkdir -p /var/lib/postgresql/data/pgdata",
    `python3 /loader.py --endpoint http://${S3_NAME}:9000 --prefix ${bucket} -d /var/lib/postgresql/data/pgdata`,
    ...(adoptLock
      ? [
          // Operator workaround, not an upstream step: take over the dead
          // instance's S3 lock so the restored node may attach to the bucket.
          `python3 -c "import boto3; boto3.client('s3', endpoint_url='http://${S3_NAME}:9000').download_file('${bucket}', 'data/orioledb_data/s3_lock', '/var/lib/postgresql/data/pgdata/orioledb_data/s3_lock')"`,
        ]
      : []),
    "chown -R postgres:postgres /var/lib/postgresql/data/pgdata",
    "chmod 700 /var/lib/postgresql/data/pgdata",
    "ls /var/lib/postgresql/data/pgdata | wc -l",
  ].join(" && ");
  return docker(
    "run", "--rm", "--network", NET, "-u", "0",
    "-e", `AWS_ACCESS_KEY_ID=${S3_KEY}`, "-e", `AWS_SECRET_ACCESS_KEY=${S3_SECRET}`, "-e", `AWS_DEFAULT_REGION=${REGION}`,
    "-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-v", `${volume}:/var/lib/postgresql/data`, "-v", `${loader}:/loader.py:ro`,
    "--entrypoint", "sh", ORIOLE_IMAGE, "-c", script,
  );
}
