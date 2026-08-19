/**
 * D05/D06/D06b - free-org disk lifecycle, the whole trilogy in one fill run.
 *
 * Free plan: 1 GiB disk, autoscale grows it on 90% usage, and read-only
 * mode triggers at 500 MB of DATABASE size (pg_database_size), not disk
 * utilization. One continuous fill of random md5 strings lets us watch all
 * three: the autoscale flip (D05), the write rejection at 500 MB (D06), and
 * recovery below the threshold (D06b) plus whether the management query
 * endpoint (postgres role) is or is not exempt from the block.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const FREE_ORG = "vkievkbeejnmbzburjkc";
const REGION = "ap-southeast-1";
const BATCH = "insert into public.dfill(line) select md5(random()::text) from generate_series(1, 1000000);";
const MAX_BATCHES = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DiskAttrs {
  attributes?: { size_gb?: number };
  last_modified_at?: string;
}

async function sql(ctx: Ctx, ref: string, query: string): Promise<{ status: number; rows: any[] }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  return { status: r.status, rows: (r.json as any[] | undefined) ?? [] };
}

async function dbSizeMb(ctx: Ctx, ref: string): Promise<number> {
  const r = await sql(ctx, ref, "select round(pg_database_size('postgres')/1024/1024) as mb;");
  return Number(r.rows[0]?.mb ?? -1);
}

async function getDisk(ctx: Ctx, ref: string): Promise<{ status: number; attrs: DiskAttrs }> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/disk`);
  return { status: r.status, attrs: (r.json as DiskAttrs | undefined) ?? {} };
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

const mod: TestModule = {
  id: "D05",
  title: "free-org autoscale flip, read-only at 500MB, recovery",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    let ref = "";
    const results: TestResult[] = [];
    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: FREE_ORG,
        name: `d05-free-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        results.push({ id: "D05", title: "D05", status: "fail", detail: `create: HTTP ${create.status} ${create.text.slice(0, 200)}` });
        return results;
      }
      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      // ---- D05: baseline disk + autoscale observation while filling ----
      const before = await getDisk(ctx, ref);
      // ACTIVE_HEALTHY is not readiness (AGENTS.md): first SQL needs backoff.
      let warmed = false;
      for (let i = 0; i < 12 && !warmed; i += 1) {
        const w = await sql(
          ctx,
          ref,
          "create table if not exists public.dfill(line text); truncate public.dfill;",
        );
        if (w.status < 300) warmed = true;
        else await sleep(5_000);
      }
      if (!warmed) throw new Error("first SQL never succeeded after 60s");

      // Seed a first batch so pg_database_size is meaningful.
      await sql(ctx, ref, BATCH);
      const sizeAtSeed = await dbSizeMb(ctx, ref);
      const diskBefore = before.attrs.attributes?.size_gb ?? null;

      let batch = 1;
      let lastDbMb = sizeAtSeed;
      let blockedAt: number | null = null;
      let blockedText = "";
      const utilOk: number[] = [];
      const utilBad: number[] = [];
      const utilEndpointStatus: number[] = [];
      for (; batch < MAX_BATCHES && blockedAt === null; batch += 1) {
        const ins = await sql(ctx, ref, BATCH);
        const util = await mgmt(ctx, "GET", `/projects/${ref}/config/disk/util`);
        utilEndpointStatus.push(util.status);
        if (util.status === 200) utilOk.push(batch);
        else utilBad.push(batch);
        if (ins.status >= 300) {
          blockedAt = lastDbMb;
          // SELECT still answers? measure, then capture the verbatim write error
          const sel = await sql(ctx, ref, "select count(*) from public.dfill;");
          const errText = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query: BATCH.slice(0, 60) });
          blockedText = `write: HTTP ${errText.status} ${errText.text.slice(0, 300)}; read: HTTP ${sel.status}`;
          break;
        }
        lastDbMb = await dbSizeMb(ctx, ref);
        ctx.log(`fill batch ${batch}: db ${lastDbMb} MB (util endpoint ${util.status})`);
        if (lastDbMb > 1500) break; // safety cap - stop beyond 1.5GB db size
      }

      const after = await getDisk(ctx, ref);
      const diskAfter = after.attrs.attributes?.size_gb ?? null;
      const utilAvail = utilOk.length > 0 ? "yes" : utilBad.length > 0 ? "no" : "untested";

      results.push({
        id: "D05",
        title: "D05: free-org disk autoscale observation",
        status: diskAfter !== null && diskBefore !== null && diskAfter !== diskBefore ? "pass" : "info",
        detail:
          !blockedAt
            ? "read-only hit before any autoscale flip was observed (or no flip)"
            : `db size at block: ${blockedAt} MB`,
        measurements: {
          initial_disk_gb: diskBefore ?? "?",
          final_disk_gb: diskAfter ?? "?",
          util_endpoint: utilAvail,
          util_endpoints_seen: utilEndpointStatus.join,
          db_size_at_seed_mb: sizeAtSeed,
        },
      });

      // ---- D06: read-only rejection (500 MB database size per docs) ----
      results.push({
        id: "D06",
        title: "D06: read-only rejection in free plan",
        status: blockedAt !== null ? "pass" : "fail",
        detail:
          blockedAt !== null
            ? `write rejected at ${blockedAt} MB db size: ${blockedText}`
            : `never blocked after ${lastDbMb} MB (batches ${batch})`,
        measurements: {
          db_size_at_block_mb: blockedAt ?? -1,
          error_text: blockedText || "none",
        },
        evidence: blockedText || undefined,
      });

      // ---- D06b: recovery: truncate -> size drops -> write succeeds ----
      let recoveryOk = false;
      let recoveryDetail = "";
      let sizeAfterTruncate: number | string = "?";
      if (blockedAt !== null && lastDbMb > 0) {
        // truncate is instant and frees relation pages without needing vacuum
        const tr = await sql(ctx, ref, "truncate public.dfill;");
        if (tr.status < 300) {
          sizeAfterTruncate = await dbSizeMb(ctx, ref);
          const probe = await sql(ctx, ref, BATCH.slice(0, 60));
          recoveryOk = probe.status < 300;
          recoveryDetail = recoveryOk ? "write accepted after truncate" : `still blocked: HTTP ${probe.status}`;
        } else {
          recoveryDetail = `truncate failed: HTTP ${tr.status}`;
        }
      } else {
        recoveryDetail = "not reached - no block observed";
      }
      results.push({
        id: "D06b",
        title: "D06b: recovery below the 500MB threshold",
        status: recoveryOk ? "pass" : blockedAt === null ? "skip" : "fail",
        detail: recoveryDetail,
        measurements: {
          db_size_after_truncate_mb: sizeAfterTruncate,
          recovery_ok: recoveryOk ? 1 : 0,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["D05", "D06", "D06b"] as const) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) {
        await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      }
    }
    return results;
  },
};
export default mod;
