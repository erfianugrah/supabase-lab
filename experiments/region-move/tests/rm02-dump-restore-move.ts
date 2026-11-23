/**
 * RM02 - a region move by dump/restore, driven only by the Management API and
 * the stock Postgres clients, at three database sizes.
 *
 * Done naively the write-stop is the whole dump plus the whole restore: writes
 * stop at the source before the dump and resume at the target after the
 * restore. RM02 times exactly that path for one table of ~1 KB incompressible
 * rows (base64 of random bytes, under the TOAST threshold, plus its primary
 * key), grown to ~10 MB, ~100 MB and ~1 GB on the source.
 *
 * Per size: drop the schema on the target, then
 *   - `pg_dump -Fc -n rm02` source -> local file, then `pg_restore` file -> target
 *     (two repeats; dump and restore timed apart), and
 *   - one streamed `pg_dump -n rm02 | psql` (plain format, no local file).
 * Row counts are compared after every restore.
 *
 * RM02a records POST /v1/projects -> ACTIVE_HEALTHY for both projects of the
 * pair (5 s poll step), and the orchestrator's round trip to each database.
 *
 * Vantage: the orchestrator machine (`where: "local"`), so the byte path is
 * source region -> orchestrator -> target region, each leg through that
 * region's session-mode pooler (IPv4, port 5432). Clients are the Postgres 17
 * binaries (PGBIN, default Homebrew postgresql@17) to match the server major.
 */
import { $ } from "bun";
import { mkdir, rm, stat } from "node:fs/promises";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { connect, diskGb, ensurePair, growDisk, poolerUser, RUN_DIR, type Proj } from "../lib/projects.js";

const PGBIN = process.env.PGBIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const SIZES_MB = (process.env.RM02_SIZES_MB ?? "10,100,1024").split(",").map(Number);
const REPEATS = Number(process.env.RM02_REPEATS ?? 2);
/** Grow both disks to this before seeding (0 = leave them); the default disk filled on the way to 1 GB. */
const DISK_GB = Number(process.env.RM02_DISK_GB ?? 8);
const ROW_BYTES_RANDOM = 768; // base64 -> 1024 chars

const secs = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;

async function rtt(p: Proj): Promise<number> {
  const c = await connect(p);
  try {
    await c.query("select 1");
    const ts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await c.query("select 1");
      ts.push(performance.now() - t);
    }
    ts.sort((a, b) => a - b);
    return Math.round(ts[2]! * 10) / 10;
  } finally {
    await c.end();
  }
}

async function growTo(src: Proj, mb: number): Promise<{ bytes: number; rows: number; seedS: number }> {
  const c = await connect(src);
  try {
    await c.query("set statement_timeout = 0");
    await c.query("create schema if not exists rm02");
    await c.query(
      "create table if not exists rm02.blob (id bigint generated always as identity primary key, payload text not null)",
    );
    const t0 = Date.now();
    for (;;) {
      const r = await c.query<{ b: string }>("select pg_total_relation_size('rm02.blob')::bigint as b");
      const bytes = Number(r.rows[0]?.b ?? 0);
      if (bytes >= mb * 1024 * 1024) break;
      const missing = mb * 1024 * 1024 - bytes;
      const rows = Math.max(1000, Math.min(200_000, Math.ceil(missing / 1150)));
      await c.query(
        `insert into rm02.blob (payload) select encode(extensions.gen_random_bytes(${ROW_BYTES_RANDOM}), 'base64') from generate_series(1, ${rows})`,
      );
    }
    const seedS = secs(t0);
    const r = await c.query<{ b: string; n: string }>(
      "select pg_total_relation_size('rm02.blob')::bigint as b, (select count(*) from rm02.blob) as n",
    );
    return { bytes: Number(r.rows[0]?.b ?? 0), rows: Number(r.rows[0]?.n ?? 0), seedS };
  } finally {
    await c.end();
  }
}

async function dropOnTarget(tgt: Proj): Promise<void> {
  const c = await connect(tgt);
  try {
    await c.query("drop schema if exists rm02 cascade");
  } finally {
    await c.end();
  }
}

async function countOn(p: Proj): Promise<number> {
  const c = await connect(p);
  try {
    const r = await c.query<{ n: string }>("select count(*) as n from rm02.blob");
    return Number(r.rows[0]?.n ?? -1);
  } finally {
    await c.end();
  }
}

async function sh(cmd: string, env: Record<string, string>): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(["sh", "-c", cmd], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [, er] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, err: er.trim().slice(-600) };
}

const mod: TestModule = {
  id: "RM02",
  title: "RM02 - dump/restore region move, write-stop by database size",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const { src, tgt } = await ensurePair(ctx);
    const [rs, rt] = [await rtt(src), await rtt(tgt)];
    results.push({
      id: "RM02a",
      title: "RM02a - create-to-ACTIVE_HEALTHY per region, and the orchestrator round trip",
      status: "info",
      detail: `status ACTIVE_HEALTHY ${src.healthySeconds ?? "?"} s / ${tgt.healthySeconds ?? "?"} s, first pooler login ${src.connectSeconds ?? "?"} s / ${tgt.connectSeconds ?? "?"} s (${src.region} / ${tgt.region}, created in parallel); select 1 median ${rs} ms / ${rt} ms`,
      measurements: {
        src_region: src.region,
        tgt_region: tgt.region,
        src_healthy_s: src.healthySeconds ?? -1,
        tgt_healthy_s: tgt.healthySeconds ?? -1,
        src_login_s: src.connectSeconds ?? -1,
        tgt_login_s: tgt.connectSeconds ?? -1,
        src_created_at: src.createdAt ?? "",
        tgt_created_at: tgt.createdAt ?? "",
        src_rtt_ms: rs,
        tgt_rtt_ms: rt,
      },
    });

    const [dsrc, dtgt] = [await diskGb(ctx, src), await diskGb(ctx, tgt)];
    let grown = "not grown";
    if (DISK_GB > 0 && (dsrc < DISK_GB || dtgt < DISK_GB)) {
      const [gs, gt] = await Promise.all([growDisk(ctx, src, DISK_GB), growDisk(ctx, tgt, DISK_GB)]);
      grown = `grown to ${DISK_GB} GB in ${gs} s / ${gt} s`;
    }
    results.push({
      id: "RM02b",
      title: "RM02b - disk size of a new project, and the grow before seeding",
      status: "info",
      detail: `created with ${dsrc} GB / ${dtgt} GB; ${grown}`,
      measurements: { src_disk_gb: dsrc, tgt_disk_gb: dtgt, grow: grown },
    });

    await mkdir(RUN_DIR, { recursive: true });
    const dumpFile = `${RUN_DIR}/rm02.dump`;
    // Passwords travel in the environment, never in argv (ps-visible).
    const env = { PGSSLMODE: "require", RM_SRC_PW: src.password, RM_TGT_PW: tgt.password };
    // Session-mode pooler, port 5432 (see lib/projects.ts poolerHost).
    const S = `PGPASSWORD="$RM_SRC_PW" "${PGBIN}/pg_dump" -h ${src.poolerHost} -p 5432 -U ${poolerUser(src)} -d postgres`;
    const T = `-h ${tgt.poolerHost} -p 5432 -U ${poolerUser(tgt)} -d postgres`;

    for (const mb of SIZES_MB) {
      try {
        await oneSize(mb);
      } catch (e) {
        results.push({
          id: `RM02-${mb}mb`,
          title: `RM02 - ${mb} MB`,
          status: "fail",
          detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        });
        break;
      }
    }
    await rm(dumpFile, { force: true });
    return results;

    async function oneSize(mb: number): Promise<void> {
      const g = await growTo(src, mb);
      for (let i = 1; i <= REPEATS; i++) {
        await dropOnTarget(tgt);
        await rm(dumpFile, { force: true });
        const t0 = Date.now();
        const d = await sh(`${S} -Fc -n rm02 -f "${dumpFile}"`, env);
        const dumpS = secs(t0);
        const fileBytes = d.code === 0 ? (await stat(dumpFile)).size : 0;
        const t1 = Date.now();
        const r = await sh(
          `PGPASSWORD="$RM_TGT_PW" "${PGBIN}/pg_restore" --no-owner --no-privileges --exit-on-error ${T} "${dumpFile}"`,
          env,
        );
        const restoreS = secs(t1);
        const n = d.code === 0 && r.code === 0 ? await countOn(tgt) : -1;
        const ok = d.code === 0 && r.code === 0 && n === g.rows;
        results.push({
          id: `RM02-${mb}mb-file-${i}`,
          title: `RM02 - ${mb} MB, pg_dump -Fc to file then pg_restore, repeat ${i}`,
          status: ok ? "pass" : "fail",
          detail: `table ${(g.bytes / 1048576).toFixed(1)} MB (${g.rows} rows), dump ${dumpS} s + restore ${restoreS} s = ${Math.round((dumpS + restoreS) * 10) / 10} s write-stop; rows on target ${n}`,
          measurements: {
            table_mb: Math.round((g.bytes / 1048576) * 10) / 10,
            rows: g.rows,
            dump_file_mb: Math.round((fileBytes / 1048576) * 10) / 10,
            dump_s: dumpS,
            restore_s: restoreS,
            write_stop_s: Math.round((dumpS + restoreS) * 10) / 10,
            target_rows: n,
            seed_s: i === 1 ? g.seedS : 0,
          },
          evidence: [d.err, r.err].filter(Boolean).join("\n---\n") || undefined,
        });
      }
      await dropOnTarget(tgt);
      const t2 = Date.now();
      const p = await sh(
        `set -o pipefail; ${S} -n rm02 | PGPASSWORD="$RM_TGT_PW" "${PGBIN}/psql" -q -v ON_ERROR_STOP=1 ${T} >/dev/null`,
        env,
      );
      const pipeS = secs(t2);
      const n = p.code === 0 ? await countOn(tgt) : -1;
      results.push({
        id: `RM02-${mb}mb-pipe`,
        title: `RM02 - ${mb} MB, streamed pg_dump | psql`,
        status: p.code === 0 && n === g.rows ? "pass" : "fail",
        detail: `${pipeS} s write-stop; rows on target ${n} of ${g.rows}`,
        measurements: { table_mb: Math.round((g.bytes / 1048576) * 10) / 10, rows: g.rows, pipe_s: pipeS, target_rows: n },
        evidence: p.err || undefined,
      });
    }
  },
};

export default mod;
