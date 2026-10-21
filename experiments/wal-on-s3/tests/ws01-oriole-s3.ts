/**
 * WS01 - OrioleDB's experimental S3 mode on a local rig: what reaches the
 * bucket, when, and what survives losing the instance and its disk.
 *
 * Claims under test (https://orioledb.com/docs/usage/decoupled-storage, read
 * 2026-10-21): data is "synced with S3 asynchronously"; another empty instance
 * can re-connect to the bucket "and get back all the data from S3 in the
 * state of the last PostgreSQL checkpoint"; only one instance may use a
 * bucket. Upstream's own restore test (test/t/s3_test.py at beta19,
 * test_s3_data_dir_load) stops the first node cleanly before restoring and
 * commits nothing after the checkpoint; these rows do both.
 *
 * Rig: lib/rig.ts. OrioleDB beta19 (pg17) and RustFS on a private Docker
 * network. Each case gets a fresh S3 server and bucket and a cluster started
 * in S3 mode from its first boot (S3 mode is fixed at initialisation).
 *
 *   WS01a  bucket contents after the first CHECKPOINT; CHECKPOINT time;
 *          whether the checkpoint is listed when CHECKPOINT returns
 *   WS01b  commits after the last checkpoint, then the instance and its disk
 *          are destroyed (SIGKILL, container and volume removed): restore
 *          with the upstream loader, start as documented, then with the dead
 *          instance's S3 lock copied into the restored directory, then with
 *          that lock deleted from the bucket (the step a crashed instance
 *          leaves to an operator); rows from before and after the checkpoint
 *   WS01c  as WS01b, with pg_switch_wal() after the late commits and a wait
 *          for that segment to be archived to the bucket
 *   WS01d  s3_desired_size = 20MB on 50,000 rows of 2,500 B: local size after
 *          eviction, point reads cold then repeated, three full counts
 *   WS01e  commit latency: pgbench single-row INSERT for 15 s with S3 mode on
 *          against a cluster with it off
 *   WS01f  as WS01b with a clean stop and start after the checkpoint (a
 *          shutdown checkpoint), and a fourth restore with a copy of the loader
 *          carrying the one-line .items() fix from upstream PR #1271 (labelled
 *          patched)
 *
 * Not settled: anything on a hosted project (orioledb OR11 reads the settings
 * there); real S3 latency (RustFS is local); a clean-stop restore (upstream
 * tests that); multiple replicas on one bucket.
 *
 * DESTRUCTIVE to the local ws3-* containers and volumes only.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  aws, docker, freshS3, listBucket, lastCheckpoint, loaderPath, patchedLoaderPath, q1, restoreInto, rmContainer, s3Flags, sleep, startPg, timedSql, waitReady,
  ORIOLE_IMAGE, NET,
} from "../lib/rig";

const BUCKET = "ws3";
const SRC_VOL = "ws3-src";
const RES_VOL = "ws3-restore";
const PG = "ws3-pg";
const PG2 = "ws3-pg2";

async function dropVolume(v: string): Promise<void> {
  if (!v.startsWith("ws3-")) throw new Error(`not a rig volume: ${v}`);
  const users = (await docker("ps", "-aq", "--filter", `volume=${v}`)).out.split("\n").filter(Boolean);
  for (const id of users) await docker("rm", "-f", id);
  await docker("volume", "rm", "-f", v);
}

/**
 * Fresh bucket and a cluster in S3 mode from its first start. S3 mode is
 * recorded at initialisation: a cluster initialised with it off refuses to
 * start with it on ("OrioleDB was initialized with S3 mode off", first run
 * 2026-10-21), so the image's init step runs with the S3 settings too.
 */
async function freshS3Cluster(extra: Record<string, string> = {}): Promise<void> {
  await rmContainer(PG);
  await rmContainer(PG2);
  await dropVolume(SRC_VOL);
  await dropVolume(RES_VOL);
  await freshS3(BUCKET);
  await docker("volume", "create", SRC_VOL);
  await startPg(PG, s3Flags(BUCKET, extra), SRC_VOL);
}

async function destroyInstance(): Promise<void> {
  await docker("kill", "-s", "KILL", PG);
  await dropVolume(SRC_VOL);
}

/** Restore, try to start; returns the start outcome and row counts. */
type LockMode = "as_documented" | "adopt_lock" | "delete_lock";

async function restoreAndCount(loader: string, mode: LockMode): Promise<Record<string, string | number>> {
  const m: Record<string, string | number> = {};
  const r = await restoreInto(RES_VOL, BUCKET, loader, mode === "adopt_lock");
  if (mode === "delete_lock") {
    const rm = await aws("s3", "rm", `s3://${BUCKET}/data/orioledb_data/s3_lock`);
    m.lock_delete_exit = rm.code;
  }
  m.loader_exit = r.code;
  if (r.code !== 0) {
    m.loader_error = (r.err.trim().split("\n").pop() ?? "").slice(0, 200);
    return m;
  }
  try {
    await startPg(PG2, s3Flags(BUCKET), RES_VOL);
    m.start = "ready";
    m.rows_total = await q1(PG2, "select count(*) from t");
    m.rows_before_checkpoint = await q1(PG2, "select count(*) from t where v = 'A'");
    m.rows_after_checkpoint = await q1(PG2, "select count(*) from t where v = 'B'");
  } catch (e) {
    const logs = await docker("logs", PG2);
    const fatal = (logs.out + logs.err).split("\n").filter((l) => /FATAL|PANIC|ERROR/.test(l));
    m.start = `failed: ${(fatal[0] ?? (e as Error).message).replace(/^.*?(FATAL|PANIC|ERROR)/, "$1").slice(0, 200)}`;
    if (fatal.length > 1) m.start_errors_logged = fatal.length;
  } finally {
    await rmContainer(PG2);
  }
  return m;
}

async function lateCommitCase(id: string, loader: string, switchWal: boolean, cleanRestart = false, patched = ""): Promise<TestResult> {
  const m: Record<string, string | number> = {};
  await freshS3Cluster();
  await q1(PG, "create table t (id int8 primary key, v text, pad text) using orioledb");
  await q1(PG, "insert into t select g, 'A', repeat('a', 200) from generate_series(1, 100000) g");
  await q1(PG, "checkpoint");
  await sleep(5000);
  if (cleanRestart) {
    // A clean stop writes a shutdown checkpoint and releases the bucket lock.
    await docker("stop", PG);
    await docker("start", PG);
    await waitReady(PG);
    m.clean_restart = "stop, start";
  }
  m.checkpoint_listed_before_late_commit = lastCheckpoint(await listBucket(BUCKET));
  await q1(PG, "insert into t select g, 'B', repeat('b', 200) from generate_series(100001, 101000) g");
  m.rows_committed_A = 100000;
  m.rows_committed_B = 1000;
  if (switchWal) {
    const seg = await q1(PG, "select pg_walfile_name(pg_current_wal_lsn())");
    await q1(PG, "select pg_switch_wal()");
    let archived = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000 && !archived) {
      archived = (await listBucket(BUCKET)).keys.some((k) => k.endsWith(seg));
      if (!archived) await sleep(1000);
    }
    m.late_segment = seg;
    m.late_segment_archived_s = archived ? Math.round((Date.now() - t0) / 100) / 10 : "not within 60 s";
  }
  const before = await listBucket(BUCKET);
  m.bucket_wal_segments_at_loss = before.keys.filter((k) => k.startsWith("wal/")).length;
  await destroyInstance();
  const plain = await restoreAndCount(loader, "as_documented");
  for (const [k, v] of Object.entries(plain)) m[`restore_${k}`] = v;
  const adopted = await restoreAndCount(loader, "adopt_lock");
  for (const [k, v] of Object.entries(adopted)) m[`adopt_lock_${k}`] = v;
  // The last attempts delete the dead instance's lock from the bucket, so they
  // run after the two that leave the bucket as the crash left it.
  const deleted = await restoreAndCount(loader, "delete_lock");
  for (const [k, v] of Object.entries(deleted)) m[`delete_lock_${k}`] = v;
  if (patched) {
    const p = await restoreAndCount(patched, "delete_lock");
    for (const [k, v] of Object.entries(p)) m[`patched_loader_delete_lock_${k}`] = v;
  }
  return {
    id,
    title: cleanRestart
      ? "clean restart, then late commits, then instance and disk lost: what a restore returns"
      : switchWal
        ? "late commits, WAL segment switched and archived, then instance and disk lost: what a restore returns"
        : "late commits after the last checkpoint, then instance and disk lost: what a restore returns",
    status: "info",
    detail: `documented restore: ${String(plain.start ?? plain.loader_error).slice(0, 60)}; lock deleted: ${String(deleted.start ?? deleted.loader_error).slice(0, 40)}, A rows ${String(deleted.rows_before_checkpoint ?? "-")} of 100000, B rows ${String(deleted.rows_after_checkpoint ?? "-")} of 1000${patched ? `; patched loader: ${String(m.patched_loader_delete_lock_start ?? m.patched_loader_delete_lock_loader_error).slice(0, 40)}, A ${String(m.patched_loader_delete_lock_rows_before_checkpoint ?? "-")}, B ${String(m.patched_loader_delete_lock_rows_after_checkpoint ?? "-")}` : ""}`,
    measurements: m,
  };
}

const mod: TestModule = {
  id: "WS01",
  title: "OrioleDB S3 mode (local rig): bucket contents, durability after instance loss, eviction, commit latency",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const loader = await loaderPath("experiments/wal-on-s3/evidence/tools");
    const env: Record<string, string> = {
      image: ORIOLE_IMAGE,
      network: NET,
      version: "",
    };
    try {
      // ---- WS01a ----
      await freshS3Cluster();
      env.version = (await q1(PG, "select version()")).slice(0, 90);
      env.orioledb_version = await q1(PG, "select extversion from pg_extension where extname = 'orioledb'");
      const m: Record<string, string | number> = { ...env };
      const empty = await listBucket(BUCKET);
      m.objects_after_start = empty.objects;
      await q1(PG, "create table t (id int8 primary key, v text, pad text) using orioledb");
      await q1(PG, "insert into t select g, 'A', repeat('a', 200) from generate_series(1, 200000) g");
      const pre = await listBucket(BUCKET);
      m.objects_before_checkpoint = pre.objects;
      m.checkpoint_before = lastCheckpoint(pre);
      const ck = await timedSql(PG, "checkpoint");
      m.checkpoint_ms = Math.round(ck.ms);
      const right = await listBucket(BUCKET);
      m.checkpoint_listed_right_after = lastCheckpoint(right);
      await sleep(10_000);
      const later = await listBucket(BUCKET);
      m.checkpoint_listed_after_10s = lastCheckpoint(later);
      m.objects_after_10s = later.objects;
      m.bytes_after_10s = later.bytes;
      for (const [p, v] of Object.entries(later.byPrefix)) m[`prefix_${p}`] = `${v.n} objects, ${v.bytes} B`;
      m.table_bytes_local = await q1(PG, "select pg_total_relation_size('t')");
      out.push({ id: "WS01a", title: "bucket contents after the first CHECKPOINT", status: "info", detail: `checkpoint ${m.checkpoint_ms} ms; listed right after: ${m.checkpoint_listed_right_after}, after 10 s: ${m.checkpoint_listed_after_10s}`, measurements: m });

      // ---- WS01b, WS01c ----
      out.push(await lateCommitCase("WS01b", loader, false));
      out.push(await lateCommitCase("WS01c", loader, true));
      out.push(await lateCommitCase("WS01f", loader, false, true, await patchedLoaderPath("experiments/wal-on-s3/evidence/tools")));

      // ---- WS01d ----
      {
        const d: Record<string, string | number> = {};
        await freshS3Cluster({ "orioledb.s3_desired_size": "20MB" });
        await q1(PG, "create table e (id int primary key, value text not null) using orioledb");
        await q1(PG, "insert into e select g, repeat('x', 2500) from generate_series(1, 50000) g");
        await q1(PG, "checkpoint");
        const sizeSql = "du -sk /var/lib/postgresql/data/pgdata/orioledb_data | cut -f1";
        const du = async () => Number((await docker("exec", PG, "sh", "-c", sizeSql)).out.trim());
        d.local_orioledb_data_kb_after_checkpoint = await du();
        const t0 = Date.now();
        let kb = d.local_orioledb_data_kb_after_checkpoint as number;
        while (Date.now() - t0 < 180_000 && kb > 20 * 1024) {
          await sleep(2000);
          kb = await du();
        }
        d.local_orioledb_data_kb_after_eviction = kb;
        d.eviction_wait_s = Math.round((Date.now() - t0) / 1000);
        // Restart so no evicted page is still in shared memory, then read.
        await docker("restart", PG);
        await waitReady(PG);
        const ids = [17, 4242, 9001, 23456, 31337, 40000, 44444, 49999];
        const cold: number[] = [];
        const warm: number[] = [];
        for (const id of ids) cold.push((await timedSql(PG, `select length(value) from e where id = ${id}`)).ms);
        for (const id of ids) warm.push((await timedSql(PG, `select length(value) from e where id = ${id}`)).ms);
        const fmt = (xs: number[]) => xs.map((x) => x.toFixed(1)).join(",");
        d.point_read_ms_cold = fmt(cold);
        d.point_read_ms_warm = fmt(warm);
        // Local size around each full count: with a 20MB cap the bgwriter
        // evicts again while the count reads, so the second count is not
        // necessarily warm.
        d.local_kb_before_count_1 = await du();
        const c1 = await timedSql(PG, "select count(*) from e");
        d.local_kb_before_count_2 = await du();
        const c2 = await timedSql(PG, "select count(*) from e");
        d.local_kb_before_count_3 = await du();
        const c3 = await timedSql(PG, "select count(*) from e");
        d.count_ms_cold = Math.round(c1.ms);
        d.count_ms_second = Math.round(c2.ms);
        d.count_ms_third = Math.round(c3.ms);
        d.count_result = c1.out;
        d.local_orioledb_data_kb_after_reads = await du();
        out.push({ id: "WS01d", title: "eviction to S3 at s3_desired_size 20MB: local size, cold against warm reads", status: c1.out === "50000" ? "pass" : "fail", detail: `local ${d.local_orioledb_data_kb_after_checkpoint} -> ${kb} kB; full count ${d.count_ms_cold}, ${d.count_ms_second}, ${d.count_ms_third} ms`, measurements: d });
      }

      // ---- WS01e ----
      {
        const e: Record<string, string | number> = {};
        const bench = async (label: string) => {
          await q1(PG, "drop table if exists b; create table b (id bigserial primary key, v text) using orioledb");
          await docker("exec", PG, "sh", "-c", "echo \"insert into b (v) values ('x');\" > /tmp/ins.sql");
          const r = await docker("exec", PG, "pgbench", "-U", "postgres", "-n", "-c", "4", "-T", "15", "-f", "/tmp/ins.sql", "postgres");
          const tps = /tps = ([0-9.]+)/.exec(r.out)?.[1] ?? "?";
          const lat = /latency average = ([0-9.]+) ms/.exec(r.out)?.[1] ?? "?";
          e[`${label}_tps`] = tps;
          e[`${label}_latency_avg_ms`] = lat;
          if (r.code !== 0) e[`${label}_error`] = r.err.slice(0, 160);
        };
        await freshS3Cluster();
        await bench("s3_on");
        await rmContainer(PG);
        await dropVolume(SRC_VOL);
        await docker("volume", "create", SRC_VOL);
        await startPg(PG, ["-c", "shared_preload_libraries=orioledb"], SRC_VOL);
        await bench("s3_off");
        e.pgbench_shape = "4 clients, 15 s, one single-row INSERT per transaction, inside the container";
        out.push({ id: "WS01e", title: "commit latency with S3 mode on and off", status: "info", detail: `on ${e.s3_on_tps} tps / ${e.s3_on_latency_avg_ms} ms; off ${e.s3_off_tps} tps / ${e.s3_off_latency_avg_ms} ms`, measurements: e });
      }
    } catch (err) {
      out.push({ id: "WS01", title: "WS01 aborted", status: "fail", detail: `threw: ${(err as Error).message.slice(0, 300)}` });
    } finally {
      await rmContainer(PG);
      await rmContainer(PG2);
      await dropVolume(SRC_VOL);
      await dropVolume(RES_VOL);
      await rmContainer("ws3-s3");
    }
    void ctx;
    return out;
  },
};

export default mod;
