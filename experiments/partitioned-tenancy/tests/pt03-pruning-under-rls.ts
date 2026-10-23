/**
 * PT03 - Does partition pruning survive a tenant RLS policy?
 *
 * SIDE: managed Pro-org Micro project (lib/project.ts), session pooler port
 * 5432 as postgres, then `set role authenticated` with request.jwt.claims
 * {"role":"authenticated","app_metadata":{"tenant_id":7}} (the
 * rls-policy-cost method; claims are session-scoped). Plans read from
 * `explain (analyze, format json)`; times are the plan's Execution Time,
 * median of 5 per row, after one warm-up.
 *
 * Fixtures (2,000,000 rows each, tenant_id 1..100 uniform, created_at uniform
 * over 2025-11-01..2026-11-01, index (tenant_id, created_at) on the parent):
 *   pr_time  range by created_at, 12 monthly partitions.
 *   pr_hash  hash by tenant_id, modulus 16.
 * Both have RLS on the parent with one SELECT policy to authenticated.
 * pr_time is dropped before pr_hash is loaded (disk).
 *
 *   PT03a  pr_time, wrapped policy, `count(*) where created_at >= '2026-10-01'`:
 *          partitions in the plan vs 12, Subplans Removed, ms.
 *   PT03b  pr_time, wrapped policy, no time filter: partitions, ms.
 *   PT03c  pr_hash, wrapped policy `tenant_id = (select ...)`, `count(*)`:
 *          partitions executed vs never executed (run-time pruning on an
 *          InitPlan parameter), Subplans Removed, ms.
 *   PT03d  pr_hash, bare policy `tenant_id = (auth.jwt() ...)::int` (a
 *          STABLE call, eligible for executor-startup pruning): same reads.
 *   PT03e  pr_hash as postgres (RLS bypassed), literal `where tenant_id = 7`:
 *          plan-time pruning baseline.
 *   PT03f  pr_hash as postgres, no filter: all 16, ms.
 *
 * All rows `info` except that every policy row must return the same count as
 * the postgres literal query (a pruning bug that hid or added rows fails).
 *
 * DESTRUCTIVE: creates and drops the two tables on the shared PT project.
 *
 * Not settled here: Micro's shared CPU makes the ms figures relative, not
 * capacity numbers; PostgREST's own query shape (CTE wrapper) is not
 * explained here; pruning with joins or with more than one tenant claim.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { brief, currentProject, ensureProject, median, pgSession, skipWithoutPro, type PgSession, type PtProject } from "../lib/project.js";

const ROWS = 2_000_000;
const CLAIMS = `{"role":"authenticated","app_metadata":{"tenant_id":7}}`;
const WRAPPED = `tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int)`;
const BARE = `tenant_id = ((auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int)`;

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Actual Loops"?: number;
  "Subplans Removed"?: number;
  Plans?: PlanNode[];
}

interface PlanRead {
  scanned: number;
  executed: number;
  never: number;
  removed: number;
  ms: number;
  count: number;
}

function walk(n: PlanNode, out: { rels: PlanNode[]; removed: number }) {
  if (n["Relation Name"]) out.rels.push(n);
  out.removed += n["Subplans Removed"] ?? 0;
  for (const c of n.Plans ?? []) walk(c, out);
}

async function explain(s: PgSession, q: string, asTenant: boolean): Promise<PlanRead> {
  const pre = asTenant ? `set role authenticated; set request.jwt.claims = '${CLAIMS}'; ` : "reset role; ";
  const e = await s.query(`${pre}explain (analyze, format json) ${q}`);
  if (e.error) throw new Error(`explain: ${e.error}`);
  const doc = e.rows[0]?.["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[];
  const out = { rels: [] as PlanNode[], removed: 0 };
  const top = doc[0];
  if (!top) throw new Error("explain: empty plan");
  walk(top.Plan, out);
  // Index-only and bitmap scans name the relation too; count distinct partitions.
  const names = new Set(out.rels.map((r) => r["Relation Name"]));
  const exec = new Set(out.rels.filter((r) => (r["Actual Loops"] ?? 0) > 0).map((r) => r["Relation Name"]));
  const c = await s.query(`${pre}${q}`);
  await s.query("reset role");
  return {
    scanned: names.size,
    executed: exec.size,
    never: names.size - exec.size,
    removed: out.removed,
    ms: Math.round(top["Execution Time"] * 100) / 100,
    count: Number(c.rows[0]?.n ?? -1),
  };
}

async function measure(s: PgSession, q: string, asTenant: boolean, n = 5): Promise<PlanRead & { msAll: number[] }> {
  await explain(s, q, asTenant); // warm-up
  const reads: PlanRead[] = [];
  for (let i = 0; i < n; i++) reads.push(await explain(s, q, asTenant));
  const last = reads[reads.length - 1]!;
  return { ...last, ms: median(reads.map((r) => r.ms)), msAll: reads.map((r) => r.ms) };
}

const row = (id: string, title: string, r: PlanRead & { msAll: number[] }, total: number, ok = true): TestResult => ({
  id,
  title,
  status: ok ? "info" : "fail",
  detail: `partitions in plan ${r.scanned}/${total}, executed ${r.executed}, never executed ${r.never}, Subplans Removed ${r.removed}; count=${r.count}; exec ms median ${r.ms} (${r.msAll.join(",")})`,
  measurements: {
    partitions_in_plan: r.scanned,
    partitions_total: total,
    partitions_executed: r.executed,
    partitions_never_executed: r.never,
    subplans_removed: r.removed,
    count: r.count,
    exec_ms_median: r.ms,
  },
});

const mod: TestModule = {
  id: "PT03",
  title: "Partition pruning with a tenant RLS policy (time range and hash by tenant)",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "PT03");
    if (skip) return skip;
    const results: TestResult[] = [];
    let p: PtProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "PT03", title: "PT03", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    let s: PgSession | null = null;
    const must = async (q: string) => {
      const r = await s!.query(q);
      if (r.error) throw new Error(`${q.slice(0, 60)}: ${r.error}`);
      return r;
    };
    try {
      s = await pgSession(p);
      await must("set statement_timeout = 0");

      // ---- pr_time ----
      const months = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(2025, 10 + i, 1));
        const e = new Date(Date.UTC(2025, 11 + i, 1));
        return { name: `pr_time_${d.toISOString().slice(0, 7).replace("-", "_")}`, from: d.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
      });
      await must(`create table public.pr_time (id bigint generated always as identity, tenant_id int not null, created_at timestamptz not null, payload jsonb, primary key (created_at, id)) partition by range (created_at)`);
      for (const m of months) await must(`create table public.${m.name} partition of public.pr_time for values from ('${m.from}') to ('${m.to}')`);
      const loadT = await must(
        `insert into public.pr_time (tenant_id, created_at, payload)
         select 1 + (g % 100), timestamptz '2025-11-01' + (random() * interval '364 days'), jsonb_build_object('g', g)
         from generate_series(1, ${ROWS}) g`,
      );
      await must(`create index on public.pr_time (tenant_id, created_at)`);
      await must(`analyze public.pr_time`);
      await must(`alter table public.pr_time enable row level security`);
      await must(`create policy tenant_read on public.pr_time for select to authenticated using (${WRAPPED})`);
      const qA = `select count(*) as n from public.pr_time where created_at >= '2026-10-01'`;
      const qB = `select count(*) as n from public.pr_time`;
      const refA = Number((await must(`select count(*) as n from public.pr_time where tenant_id = 7 and created_at >= '2026-10-01'`)).rows[0]?.n);
      const refB = Number((await must(`select count(*) as n from public.pr_time where tenant_id = 7`)).rows[0]?.n);
      const a = await measure(s, qA, true);
      results.push(row("PT03a", "PT03a: range by month, tenant policy (wrapped), last-month filter", a, 12, a.count === refA));
      const b = await measure(s, qB, true);
      results.push(row("PT03b", "PT03b: range by month, tenant policy (wrapped), no time filter", b, 12, b.count === refB));
      const size1 = (await must(`select pg_size_pretty(pg_database_size('postgres')) as s`)).rows[0]?.s;
      await must(`drop table public.pr_time`);

      // ---- pr_hash ----
      await must(`create table public.pr_hash (id bigint generated always as identity, tenant_id int not null, created_at timestamptz not null, payload jsonb, primary key (tenant_id, created_at, id)) partition by hash (tenant_id)`);
      for (let i = 0; i < 16; i++) await must(`create table public.pr_hash_${i} partition of public.pr_hash for values with (modulus 16, remainder ${i})`);
      const loadH = await must(
        `insert into public.pr_hash (tenant_id, created_at, payload)
         select 1 + (g % 100), timestamptz '2025-11-01' + (random() * interval '364 days'), jsonb_build_object('g', g)
         from generate_series(1, ${ROWS}) g`,
      );
      await must(`analyze public.pr_hash`);
      await must(`alter table public.pr_hash enable row level security`);
      await must(`create policy tenant_read on public.pr_hash for select to authenticated using (${WRAPPED})`);
      const qH = `select count(*) as n from public.pr_hash`;
      const refH = Number((await must(`select count(*) as n from public.pr_hash where tenant_id = 7`)).rows[0]?.n);
      const c = await measure(s, qH, true);
      results.push(row("PT03c", "PT03c: hash by tenant, wrapped policy (InitPlan parameter)", c, 16, c.count === refH));
      await must(`drop policy tenant_read on public.pr_hash`);
      await must(`create policy tenant_read on public.pr_hash for select to authenticated using (${BARE})`);
      const d = await measure(s, qH, true);
      results.push(row("PT03d", "PT03d: hash by tenant, bare policy (stable function call)", d, 16, d.count === refH));
      const e = await measure(s, `select count(*) as n from public.pr_hash where tenant_id = 7`, false);
      results.push(row("PT03e", "PT03e: hash by tenant, postgres, literal tenant_id = 7 (plan-time pruning baseline)", e, 16, e.count === refH));
      const f = await measure(s, qH, false);
      results.push(row("PT03f", "PT03f: hash by tenant, postgres, no filter (all partitions)", f, 16));
      const size2 = (await must(`select pg_size_pretty(pg_database_size('postgres')) as s`)).rows[0]?.s;
      await must(`drop table public.pr_hash`);
      results.push({
        id: "PT03z",
        title: "PT03z: fixture load",
        status: "info",
        detail: `pr_time load ${loadT.ms} ms, pr_hash load ${loadH.ms} ms for ${ROWS} rows each; database size with pr_time ${String(size1)}, with pr_hash ${String(size2)}`,
        measurements: { rows_per_table: ROWS, load_time_ms: loadT.ms, load_hash_ms: loadH.ms, db_size_time: String(size1), db_size_hash: String(size2) },
      });
    } catch (err) {
      results.push({ id: "PT03", title: "PT03", status: "fail", detail: red(err instanceof Error ? err.message : String(err)) });
      if (s) {
        await s.query("reset role; drop table if exists public.pr_time; drop table if exists public.pr_hash");
      }
    } finally {
      await s?.close();
    }
    return results;
  },
};
export default mod;
