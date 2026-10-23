/**
 * PT04 - What does detaching an old partition cost Data API clients that are
 * reading and writing the same partitioned table?
 *
 * SIDE: managed Pro-org Micro project (lib/project.ts). DDL runs as postgres
 * on the session pooler (port 5432; DETACH ... CONCURRENTLY cannot run inside
 * a transaction block, and the Management query endpoint wraps statements in
 * one). Load: two client loops through the Data API with a tenant-1 user
 * access token (apikey = legacy anon): a reader (`GET /rest/v1/dt_events
 * ?order=created_at.desc&limit=20`) and a writer (`POST` one tenant-1 row into
 * the current month, return=minimal), each issuing its next request as soon as
 * the previous one answers. Each window: 3 s baseline, the DDL, 3 s after.
 *
 * Table public.dt_events range by month, RLS on the parent (tenant policy,
 * wrapped form). Partitions: 2026_05 and 2026_06 at 200,000 rows,
 * 2026_07 and 2026_08 at 1,000,000 rows, 2026_10 (current, small).
 *
 *   PT04a  DETACH CONCURRENTLY of 2026_07 (1M rows), no other transaction:
 *          DDL ms; reader/writer requests, non-2xx, max and median ms.
 *   PT04b  the same for 2026_08 (n = 2 for the headline).
 *   PT04c  DETACH CONCURRENTLY of 2026_05 while a separate session holds a
 *          15 s transaction that read the parent: DDL ms; client effect.
 *   PT04d  plain DETACH (no CONCURRENTLY) of 2026_06 while the same kind of
 *          15 s transaction is open: DDL ms; client effect (expect queued
 *          clients behind the ACCESS EXCLUSIVE request, and 57014 at the
 *          authenticated role's statement timeout).
 *   PT04e  the detached tables standalone: row counts, relrowsecurity, anon
 *          SELECT privilege, an anon Data API read; parent no longer returns
 *          their rows.
 *
 * All rows `info` (there is no correct latency); PT04e's counts must match the
 * loaded rows or it fails.
 *
 * DESTRUCTIVE: creates and drops tables on the shared PT project.
 *
 * Not settled here: archiving the detached table elsewhere (cold storage) -
 * not attempted; ATTACH cost; DETACH on larger compute or under heavier load.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  awaitExposed,
  brief,
  codeOf,
  currentProject,
  ensureProject,
  median,
  pgSession,
  rest,
  rowCount,
  skipWithoutPro,
  sleep,
  tenantsSeen,
  tenantUser,
  type PgSession,
  type PtProject,
  type RestResult,
} from "../lib/project.js";

interface Sample {
  t: number;
  status: number;
  ms: number;
  code: string;
}

interface LoopStats {
  n: number;
  bad: number;
  codes: string;
  maxMs: number;
  medMs: number;
}

function stats(xs: Sample[]): LoopStats {
  const bad = xs.filter((x) => x.status < 200 || x.status >= 300);
  const codes = [...new Set(bad.map((x) => `${x.status}${x.code ? `/${x.code}` : ""}`))].join(",");
  return { n: xs.length, bad: bad.length, codes: codes || "-", maxMs: xs.length ? Math.max(...xs.map((x) => x.ms)) : -1, medMs: median(xs.map((x) => x.ms)) };
}

async function underLoad(p: PtProject, token: string, ddl: () => Promise<{ ms: number; error?: string }>) {
  let stop = false;
  const reads: Sample[] = [];
  const writes: Sample[] = [];
  const t0 = performance.now();
  const loop = async (out: Sample[], fn: () => Promise<RestResult>) => {
    while (!stop) {
      const r = await fn();
      out.push({ t: Math.round(performance.now() - t0), status: r.status, ms: r.ms, code: codeOf(r) });
    }
  };
  const lr = loop(reads, () => rest(p.host, "/rest/v1/dt_events?select=id,created_at&order=created_at.desc&limit=20", p.keys.anon, { bearer: token, timeoutMs: 30_000 }));
  const lw = loop(writes, () =>
    rest(p.host, "/rest/v1/dt_events", p.keys.anon, {
      bearer: token,
      method: "POST",
      body: { tenant_id: 1, created_at: new Date().toISOString(), payload: { w: 1 } },
      headers: { Prefer: "return=minimal" },
      timeoutMs: 30_000,
    }),
  );
  await sleep(3_000);
  const dStart = Math.round(performance.now() - t0);
  const d = await ddl();
  const dEnd = Math.round(performance.now() - t0);
  await sleep(3_000);
  stop = true;
  await Promise.all([lr, lw]);
  // Samples whose request overlapped the DDL window.
  const during = (xs: Sample[]) => xs.filter((x) => x.t >= dStart && x.t - x.ms <= dEnd);
  return { ddl: d, all: { r: stats(reads), w: stats(writes) }, during: { r: stats(during(reads)), w: stats(during(writes)) } };
}

async function holdTransaction(p: PtProject, holdMs: number): Promise<{ done: Promise<void>; opened: Promise<void> }> {
  const s = await pgSession(p);
  let markOpen: () => void = () => {};
  const opened = new Promise<void>((r) => (markOpen = r));
  const done = (async () => {
    await s.query("begin");
    await s.query("select count(*) from public.dt_events");
    markOpen();
    await sleep(holdMs);
    await s.query("commit");
    await s.close();
  })();
  return { done, opened };
}

function loadRow(id: string, title: string, r: Awaited<ReturnType<typeof underLoad>>, extra = ""): TestResult {
  const d = r.during;
  return {
    id,
    title,
    status: "info",
    detail: `DDL ${r.ddl.ms} ms${r.ddl.error ? ` error ${r.ddl.error}` : ""}${extra}; overlapping DDL: reads ${d.r.n} (non-2xx ${d.r.bad} ${d.r.codes}, max ${d.r.maxMs} ms, median ${d.r.medMs}), writes ${d.w.n} (non-2xx ${d.w.bad} ${d.w.codes}, max ${d.w.maxMs} ms, median ${d.w.medMs}); whole window: reads ${r.all.r.n} median ${r.all.r.medMs} ms, writes ${r.all.w.n} median ${r.all.w.medMs} ms`,
    measurements: {
      ddl_ms: r.ddl.ms,
      ddl_error: r.ddl.error ?? "",
      during_reads: d.r.n,
      during_reads_non2xx: d.r.bad,
      during_reads_codes: d.r.codes,
      during_reads_max_ms: d.r.maxMs,
      during_reads_median_ms: d.r.medMs,
      during_writes: d.w.n,
      during_writes_non2xx: d.w.bad,
      during_writes_codes: d.w.codes,
      during_writes_max_ms: d.w.maxMs,
      window_reads_median_ms: r.all.r.medMs,
      window_writes_median_ms: r.all.w.medMs,
      window_reads_non2xx: r.all.r.bad,
      window_writes_non2xx: r.all.w.bad,
    },
  };
}

const mod: TestModule = {
  id: "PT04",
  title: "Detaching an old partition while Data API clients read and write",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "PT04");
    if (skip) return skip;
    const results: TestResult[] = [];
    let p: PtProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "PT04", title: "PT04", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const red = (s: string) => brief(currentProject(), s, 300);
    let s: PgSession | null = null;
    const must = async (q: string) => {
      const r = await s!.query(q);
      if (r.error) throw new Error(`${q.slice(0, 60)}: ${r.error}`);
      return r;
    };
    const ddl = (q: string) => async () => {
      const r = await s!.query(q);
      return { ms: r.ms, error: r.error ? `${r.code} ${r.error}`.slice(0, 160) : undefined };
    };
    const sizes: Record<string, number> = { "2026_05": 200_000, "2026_06": 200_000, "2026_07": 1_000_000, "2026_08": 1_000_000 };
    try {
      s = await pgSession(p);
      await must("set statement_timeout = 0");
      await must(`create table public.dt_events (id bigint generated always as identity, tenant_id int not null, created_at timestamptz not null, payload jsonb, primary key (created_at, id)) partition by range (created_at)`);
      // Parent only: the load loops go through it. The partitions keep whatever the default privileges give them, which PT04e measures.
      await must(`grant select, insert, update, delete on table public.dt_events to anon, authenticated, service_role`);
      for (const m of ["2026_05", "2026_06", "2026_07", "2026_08", "2026_09", "2026_10", "2026_11"]) {
        const [y = 0, mo = 0] = m.split("_").map(Number);
        const from = new Date(Date.UTC(y, mo - 1, 1)).toISOString().slice(0, 10);
        const to = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
        await must(`create table public.dt_events_${m} partition of public.dt_events for values from ('${from}') to ('${to}')`);
      }
      for (const [m, n] of Object.entries(sizes)) {
        const [y = 0, mo = 0] = m.split("_").map(Number);
        const from = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
        await must(
          `insert into public.dt_events (tenant_id, created_at, payload)
           select 1 + (g % 50), timestamptz '${from}' + (random() * interval '27 days'), jsonb_build_object('g', g) from generate_series(1, ${n}) g`,
        );
      }
      await must(`insert into public.dt_events (tenant_id, created_at, payload) select 1 + (g % 50), now() - (random() * interval '1 day'), '{}' from generate_series(1, 1000) g`);
      await must(`create index on public.dt_events (tenant_id, created_at)`);
      await must(`analyze public.dt_events`);
      await must(`alter table public.dt_events enable row level security`);
      await must(`create policy tenant_rw on public.dt_events for all to authenticated
        using (tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int))
        with check (tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int))`);
      await awaitExposed(ctx, p, "/rest/v1/dt_events?select=id&limit=1");
      const u = await tenantUser(p, 1);
      // Run 2 (2026-10-22) met `25006 read-only transaction` on every DDL after the
      // loads; record the database size and the read-only flag the windows start from.
      const ro = await s.query(`select current_setting('default_transaction_read_only') as ro, pg_size_pretty(pg_database_size('postgres')) as sz`);
      results.push({
        id: "PT04z",
        title: "PT04z: database state before the DETACH windows",
        status: "info",
        detail: `default_transaction_read_only=${String(ro.rows[0]?.ro ?? ro.error)}; database size ${String(ro.rows[0]?.sz ?? "")}`,
        measurements: { read_only_before: String(ro.rows[0]?.ro ?? ""), db_size_before: String(ro.rows[0]?.sz ?? "") },
      });

      // ---- PT04a / PT04b ----
      const a = await underLoad(p, u.token, ddl(`alter table public.dt_events detach partition public.dt_events_2026_07 concurrently`));
      results.push(loadRow("PT04a", "PT04a: DETACH CONCURRENTLY, 1M-row partition, no other transaction (rep 1)", a));
      const b = await underLoad(p, u.token, ddl(`alter table public.dt_events detach partition public.dt_events_2026_08 concurrently`));
      results.push(loadRow("PT04b", "PT04b: DETACH CONCURRENTLY, 1M-row partition, no other transaction (rep 2)", b));

      // ---- PT04c ----
      const h1 = await holdTransaction(p, 15_000);
      await h1.opened;
      const c = await underLoad(p, u.token, ddl(`alter table public.dt_events detach partition public.dt_events_2026_05 concurrently`));
      await h1.done;
      results.push(loadRow("PT04c", "PT04c: DETACH CONCURRENTLY while a 15 s transaction that read the parent is open", c, "; holder opened before the window"));

      // ---- PT04d ----
      const h2 = await holdTransaction(p, 15_000);
      await h2.opened;
      const d = await underLoad(p, u.token, ddl(`alter table public.dt_events detach partition public.dt_events_2026_06`));
      await h2.done;
      results.push(loadRow("PT04d", "PT04d: plain DETACH while a 15 s transaction that read the parent is open", d, "; holder opened before the window"));

      // ---- PT04e ----
      const parts = ["2026_05", "2026_06", "2026_07", "2026_08"];
      const meta = await must(
        `select c.relname, c.relrowsecurity as rls, has_table_privilege('anon', c.oid, 'select') as anon_select,
           exists (select 1 from pg_inherits i where i.inhrelid = c.oid) as attached
         from pg_class c where c.relname in (${parts.map((m) => `'dt_events_${m}'`).join(",")}) order by 1`,
      );
      const counts: Record<string, number> = {};
      for (const m of parts) counts[m] = Number((await must(`select count(*) as n from public.dt_events_${m}`)).rows[0]?.n);
      const inParent = Number((await must(`select count(*) as n from public.dt_events where created_at < '2026-09-01'`)).rows[0]?.n);
      await awaitExposed(ctx, p, `/rest/v1/dt_events_2026_07?select=id&limit=1`, 45_000);
      const an = await rest(p.host, `/rest/v1/dt_events_2026_07?select=id,tenant_id&limit=1000`, p.keys.anon);
      const countsOk = parts.every((m) => counts[m] === sizes[m]);
      results.push({
        id: "PT04e",
        title: "PT04e: the detached tables standalone",
        status: countsOk ? "info" : "fail",
        detail: `${meta.rows.map((r) => `${String(r.relname).replace("dt_events_", "")}: attached=${r.attached} rls=${r.rls} anon_select=${r.anon_select} rows=${counts[String(r.relname).replace("dt_events_", "")]}`).join("; ")}; parent rows before 2026-09 = ${inParent}; anon Data API read of a detached table ${an.status} rows=${rowCount(an)} (limit 1000) tenants=${tenantsSeen(an) ? tenantsSeen(an).split(",").length : 0}`,
        measurements: {
          detached_attached: meta.rows.filter((r) => r.attached === true).length,
          detached_rls_on: meta.rows.filter((r) => r.rls === true).length,
          detached_anon_select: meta.rows.filter((r) => r.anon_select === true).length,
          detached_rows_2026_07: counts["2026_07"] ?? -1,
          parent_rows_before_sep: inParent,
          detached_anon_status: an.status,
          detached_anon_rows_limit1000: rowCount(an),
          detached_anon_distinct_tenants: tenantsSeen(an) ? tenantsSeen(an).split(",").length : 0,
        },
      });
      await must(`drop table if exists public.dt_events, public.dt_events_2026_05, public.dt_events_2026_06, public.dt_events_2026_07, public.dt_events_2026_08`);
    } catch (e) {
      results.push({ id: "PT04", title: "PT04", status: "fail", detail: red(e instanceof Error ? e.message : String(e)) });
    } finally {
      await s?.close();
    }
    return results;
  },
};
export default mod;
