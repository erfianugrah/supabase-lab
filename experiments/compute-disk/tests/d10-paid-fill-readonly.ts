/**
 * D10 - paid-plan disk lifecycle under fill (Pro org, throwaway Micro project).
 *
 * The paid-plan half of D05/D06, left doc-only as "prohibitive fill" until a
 * fresh Pro project turned out to start on a 2 GB volume, not 8 GB.
 *
 *   D10a  "uploading more than 1.5x the current size ... will put your
 *         database into read-only mode" - seed ~200 MB, burst-load >1.5x it
 *         back to back, then try a write.
 *   D10b  autoscale at 90%: paced ~25 MB batches, one fresh util sample per
 *         batch, stop at the first grow and record the step.
 *   D10c  the first grow spent the modification quota (manual POSTs now 429
 *         "once per four hours"), so burst-fill again and record what refuses
 *         the write: read-only (25006) or a full disk (53100).
 *   D10d  recovery after the refusal with nothing done by the caller: time
 *         until a plain write lands, whether autoscale grew again inside the
 *         manual cooldown, whether the postmaster restarted.
 *
 * The first run (2026-10-01) is the reason for `classify`: it counted a
 * dropped connection as read-only. See the RUNLOG entry of that date.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const REGION = "ap-southeast-1";
// Two md5s per row defeat TOAST compression: ~100 bytes of heap per row.
const batch = (t: string, rows: number) =>
  `insert into public.${t}(line) select md5(random()::text) || md5(random()::text) from generate_series(1, ${rows});`;
const BURST_ROWS = 1_000_000; // ~100 MB per call
const PACED_ROWS = 250_000; // ~25 MB per call
const PROBE_WRITE = "insert into public.dprobe(v) values (1);";
const SEED_MB = 200; // 2 GB volume: seed + 1.6x burst stays near 30% so the burst tests the 1.5x rule, not disk-full
const UTIL_WAIT_MS = 3 * 60_000;
const BUDGET_MS = 150 * 60_000;
const SQL_TIMEOUT = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Kind = "ok" | "readonly" | "diskfull" | "down" | "other";
// A refused write is only read-only mode when Postgres says so. Run 1 counted a
// dropped connection as "tripped" and was wrong: the database had gone down.
function classify(status: number, text: string): Kind {
  if (status < 300) return "ok";
  if (/25006|read-only transaction/.test(text)) return "readonly";
  if (/53100|No space left|disk_full/i.test(text)) return "diskfull";
  if (/57P03|Connection terminated|ECONNRESET|timed out|not accepting connections/i.test(text) || status === 599) return "down";
  return "other";
}

async function sql(ctx: Ctx, ref: string, query: string) {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, SQL_TIMEOUT).catch(
    (e) => ({ status: 599, text: String(e), json: undefined }),
  );
  return { status: r.status, text: r.text, rows: (r.json as any[] | undefined) ?? [], kind: classify(r.status, r.text) };
}

async function dbMb(ctx: Ctx, ref: string): Promise<number> {
  const r = await sql(ctx, ref, "select round(pg_database_size('postgres')/1024/1024) as mb;");
  return Number(r.rows[0]?.mb ?? -1);
}

async function diskGb(ctx: Ctx, ref: string): Promise<number | null> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
  return ((r.json as any)?.attributes?.size_gb ?? null) as number | null;
}

interface Util { ts: string; pct: number }
async function util(ctx: Ctx, ref: string): Promise<Util | null> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/util`);
  const j = r.json as any;
  if (r.status !== 200 || !j?.metrics?.fs_size_bytes) return null;
  return { ts: j.timestamp, pct: Math.round((j.metrics.fs_used_bytes / j.metrics.fs_size_bytes) * 1000) / 10 };
}

// The util metric is sampled, not live (run 1 read a 15-minute-old value while
// the disk was full). Wait for a sample newer than `after` before trusting it.
async function freshUtil(ctx: Ctx, ref: string, after: string): Promise<Util | null> {
  const end = Date.now() + UTIL_WAIT_MS;
  let u = await util(ctx, ref);
  while (Date.now() < end && (!u || u.ts <= after)) {
    await sleep(15_000);
    u = await util(ctx, ref);
  }
  return u;
}

async function readonly(ctx: Ctx, ref: string): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/readonly`);
  return `${r.status} ${r.text.slice(0, 160)}`;
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

// Run 1: /config/disk/util kept returning its baseline sample for 15+ minutes
// while data + WAL filled the disk, so gate on what Postgres itself reports:
// every database plus pg_wal, against the provisioned volume.
async function pgPct(ctx: Ctx, ref: string, diskGbNow: number | null): Promise<{ pct: number; walMb: number; dbMb: number } | null> {
  const r = await sql(
    ctx,
    ref,
    "select (select sum(size) from pg_ls_waldir())::bigint as wal, (select sum(pg_database_size(datname)) from pg_database)::bigint as dbs;",
  );
  const row = r.rows[0];
  if (r.kind !== "ok" || !row || !diskGbNow) return null;
  const used = Number(row.wal) + Number(row.dbs);
  return { pct: Math.round((used / (diskGbNow * 1024 ** 3)) * 1000) / 10, walMb: Math.round(Number(row.wal) / 2 ** 20), dbMb: Math.round(Number(row.dbs) / 2 ** 20) };
}

const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

const mod: TestModule = {
  id: "D10",
  title: "paid-plan fill: 1.5x import, autoscale at 90%, read-only at 95%, recovery",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "D10", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    const push = (r: TestResult) => {
      results.push(r);
      ctx.log(`${r.id} ${r.status}: ${r.detail}`);
    };
    let ref = "";
    const t0 = Date.now();
    try {
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `d10-fill-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) throw new Error(`create: HTTP ${create.status} ${create.text.slice(0, 200)}`);
      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);
      // ACTIVE_HEALTHY is not readiness (AGENTS.md): first SQL needs backoff.
      let warmed = false;
      for (let i = 0; i < 12 && !warmed; i += 1) {
        const w = await sql(
          ctx,
          ref,
          "create table if not exists public.dfill_a(line text); create table if not exists public.dfill_b(line text); create table if not exists public.dprobe(v int);",
        );
        if (w.status < 300) warmed = true;
        else await sleep(5_000);
      }
      if (!warmed) throw new Error("first SQL never succeeded after 60s");

      const disk0 = await diskGb(ctx, ref);
      const auto0 = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/autoscale`);
      const ro0 = await readonly(ctx, ref);
      ctx.log(`baseline: disk ${disk0} GB, util ${(await util(ctx, ref))?.pct}%, autoscale ${auto0.status} ${auto0.text}, readonly ${ro0}`);

      // ---- seed dfill_a ----
      let db = await dbMb(ctx, ref);
      while (db < SEED_MB) {
        const r = await sql(ctx, ref, batch("dfill_a", PACED_ROWS));
        if (r.kind !== "ok") throw new Error(`seed write failed at ${db} MB: ${r.status} ${r.text.slice(0, 200)}`);
        db = await dbMb(ctx, ref);
      }
      const seedMb = db;

      // ---- D10a: burst >1.5x the seed, no pauses ----
      const burstT0 = Date.now();
      let burstFail = "";
      let burstKind: Kind = "ok";
      while (db < seedMb * 2.6) {
        const r = await sql(ctx, ref, batch("dfill_b", BURST_ROWS));
        if (r.kind !== "ok") {
          burstKind = r.kind;
          burstFail = `${r.status} ${r.text.slice(0, 200)}`;
          break;
        }
        db = await dbMb(ctx, ref);
      }
      const burstS = Math.round((Date.now() - burstT0) / 1000);
      const probeA = await sql(ctx, ref, PROBE_WRITE);
      if (burstKind === "ok" && probeA.kind !== "ok") {
        burstKind = probeA.kind;
        burstFail = `${probeA.status} ${probeA.text.slice(0, 200)}`;
      }
      const roA = await readonly(ctx, ref);
      const utilA = await freshUtil(ctx, ref, isoNow());
      push({
        id: "D10a",
        title: "D10a: >1.5x burst import vs read-only",
        status: "info",
        detail:
          burstKind === "ok"
            ? `no read-only: loaded ${db - seedMb} MB onto a ${seedMb} MB db (${((db - seedMb) / seedMb).toFixed(2)}x) in ${burstS}s; util ${utilA?.pct}% on ${disk0} GB`
            : `write refused (${burstKind}) during/after the burst: ${burstFail}`,
        measurements: {
          seed_db_mb: seedMb,
          db_after_burst_mb: db,
          loaded_ratio: Number(((db - seedMb) / seedMb).toFixed(2)),
          burst_s: burstS,
          refusal_kind: burstKind,
          util_after_pct: utilA?.pct ?? "?",
          readonly_get: roA,
        },
      });
      if (burstKind !== "ok") throw new Error(`burst left the db unwritable (${burstKind}); paced phase not run`);

      // ---- D10b: paced fill until the first grow ----
      let lastDisk = disk0;
      let lastU: Util | null = utilA;
      let growth = "";
      let n = 0;
      while (!growth && Date.now() - t0 < BUDGET_MS) {
        n += 1;
        const before = isoNow();
        const r = await sql(ctx, ref, batch("dfill_b", PACED_ROWS));
        if (r.kind !== "ok") throw new Error(`paced write refused (${r.kind}) at util ${lastU?.pct}% before any grow: ${r.text.slice(0, 200)}`);
        db = await dbMb(ctx, ref);
        const u = await freshUtil(ctx, ref, before);
        const d = await diskGb(ctx, ref);
        const pg = await pgPct(ctx, ref, d);
        if (d !== null && lastDisk !== null && d !== lastDisk) {
          growth = `${lastDisk}->${d} GB at t+${Math.round((Date.now() - t0) / 1000)}s (util before ${lastU?.pct}%, db ${db} MB)`;
          ctx.log(`autoscale: ${growth}`);
          lastDisk = d;
        }
        if (u) lastU = u;
        ctx.log(`paced ${n}: db ${db} MB, wal ${pg?.walMb} MB, data+wal ${pg?.pct}% of ${d} GB, util-endpoint ${u?.pct}% @${u?.ts}`);
      }
      push({
        id: "D10b",
        title: "D10b: autoscale at 90% on Pro (paced fill)",
        status: growth ? "pass" : "info",
        detail: growth || `no growth within budget (last util ${lastU?.pct}%)`,
        measurements: { initial_disk_gb: disk0 ?? "?", grown_disk_gb: lastDisk ?? "?", util_before_grow_pct: lastU?.pct ?? "?" },
      });
      if (!growth) throw new Error("no grow observed; D10c/D10d need a spent quota");

      // ---- D10c: burst with the modification quota spent ----
      const quota = await mgmt(ctx, "POST", `/projects/${ref}/config/disk`, {
        attributes: { type: "gp3", size_gb: (lastDisk ?? 8) + 1, iops: 3000, throughput_mibps: 125 },
      });
      let refused: { kind: Kind; text: string; pg: number | null } | null = null;
      let lastPg: number | null = null;
      for (let i = 0; i < 400 && !refused && Date.now() - t0 < BUDGET_MS; i += 1) {
        const r = await sql(ctx, ref, batch("dfill_b", BURST_ROWS));
        if (r.kind !== "ok") {
          refused = { kind: r.kind, text: `${r.status} ${r.text.slice(0, 300)}`, pg: lastPg };
          break;
        }
        lastPg = (await pgPct(ctx, ref, lastDisk))?.pct ?? lastPg;
      }
      const refusedAt = Date.now();
      push({
        id: "D10c",
        title: "D10c: what refuses a burst once the quota is spent",
        status: refused?.kind === "readonly" ? "pass" : "info",
        detail: refused
          ? `${refused.kind} at data+wal ~${refused.pg}% of ${lastDisk} GB: ${refused.text}`
          : "never refused within budget",
        measurements: { manual_post_status: quota.status, manual_post: quota.text.slice(0, 120), refusal_kind: refused?.kind ?? "none", data_wal_pct_before: refused?.pg ?? -1 },
        evidence: refused?.text,
      });

      // ---- D10d: hands-off recovery ----
      let back = -1;
      let roSeen = false;
      let up = "";
      let diskAfter = lastDisk;
      while (refused && Date.now() - refusedAt < 30 * 60_000) {
        await sleep(30_000);
        const ro = await readonly(ctx, ref);
        if (/"enabled":true/.test(ro)) roSeen = true;
        diskAfter = (await diskGb(ctx, ref)) ?? diskAfter;
        const p = await sql(ctx, ref, PROBE_WRITE);
        if (p.kind === "readonly") roSeen = true;
        if (p.kind === "ok") {
          back = Math.round((Date.now() - refusedAt) / 1000);
          const u = await sql(ctx, ref, "select extract(epoch from now()-pg_postmaster_start_time())::int as s;");
          up = String(u.rows[0]?.s ?? "?");
          break;
        }
      }
      push({
        id: "D10d",
        title: "D10d: hands-off recovery after the refusal",
        status: back >= 0 ? "pass" : refused ? "fail" : "skip",
        detail:
          back >= 0
            ? `plain write accepted ${back}s after the refusal; disk ${lastDisk}->${diskAfter} GB; read-only seen: ${roSeen}; postmaster up ${up}s`
            : refused
              ? `still refusing after 30 min; disk ${diskAfter} GB`
              : "no refusal to recover from",
        measurements: { seconds_to_write: back, disk_after_gb: diskAfter ?? "?", readonly_seen: roSeen ? 1 : 0, postmaster_uptime_s: up || "?" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["D10a", "D10b", "D10c", "D10d"]) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
