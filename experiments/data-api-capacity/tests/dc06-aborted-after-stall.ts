/**
 * DC06 - After a stall that makes many in-flight Data API requests hit their
 * statement timeout at once, do PostgREST's pooled connections come back
 * clean, or do some stay `idle in transaction (aborted)` and fail later
 * requests with 25P02 ("current transaction is aborted") until the pool
 * recycles them?
 *
 * The failure mode tested: a burst of 57014 cancellations, then a minority
 * of pooled connections left aborted and every request that lands on one
 * answering 500 25P02, clearing only when the pool's max lifetime rotates
 * the connection. Competing hypothesis: PostgREST rolls back after every
 * error, so a cancellation never leaves a connection aborted, and the failure
 * case needs a stall shape this probe cannot make (Postgres frozen whole, so
 * the cancel lands at BIND, rather than one table locked).
 *
 * Stall used here: `lock table public.dc_items in access exclusive mode`
 * held by a Management API query for LOCK_S, while 20 workers loop anon GETs
 * on dc_items (anon's statement_timeout is 3 s, DC03a). Arms: a 2 s lock
 * (control: no waiting request passes 3 s), then a 12 s lock (every waiting
 * request does). The lock runs inside an explicit begin/commit so it is held
 * for the sleep whether or not the endpoint wraps a multi-statement query.
 * Per arm: status:code counts before, during and after the lock;
 * `authenticator` states sampled every 5 s; 25P02 answers after the lock and
 * the most `idle in transaction (aborted)` backends seen.
 *
 * Not settled here: a whole-instance freeze (no way to SIGSTOP Postgres on a
 * managed project), PostgREST versions other than the project's, the
 * authenticated role's 8 s timeout.
 *
 * DESTRUCTIVE: uses the shared project (lib/dc.ts); DC99 deletes it.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureItems, ensureProject, errText, fmtCounts, redact, skipWithoutPro, sleep, sql, type DcProject } from "../lib/dc.js";

const WORKERS = 20;

interface Hit {
  t: number;
  status: number;
  code: string;
}

async function get(p: DcProject): Promise<Hit> {
  const id = 1 + Math.floor(Math.random() * 100_000);
  try {
    const res = await fetch(`https://${p.host}/rest/v1/dc_items?id=eq.${id}&select=id`, {
      headers: { apikey: p.keys.anon, Authorization: `Bearer ${p.keys.anon}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    let code = "";
    if (res.status >= 300) {
      try {
        code = String((JSON.parse(body) as { code?: string }).code ?? "");
      } catch {
        code = "non-json";
      }
    }
    return { t: Date.now(), status: res.status, code };
  } catch (e) {
    return { t: Date.now(), status: 0, code: errText(e).slice(0, 40) };
  }
}

async function states(ctx: Ctx, ref: string): Promise<{ t: number; s: string; aborted: number }> {
  const r = await sql(
    ctx,
    ref,
    `select coalesce(string_agg(state || ':' || n, ' ' order by state), 'none') as s,
            coalesce(sum(n) filter (where state = 'idle in transaction (aborted)'), 0)::int as aborted
       from (select coalesce(state, 'null') as state, count(*) as n from pg_stat_activity where usename = 'authenticator' group by 1) x`,
    15_000,
  );
  const row = r.rows?.[0];
  return { t: Date.now(), s: String(row?.s ?? `error ${r.error ?? r.status}`), aborted: Number(row?.aborted ?? -1) };
}

const counts = (hs: Hit[]) => {
  const c: Record<string, number> = {};
  for (const h of hs) c[`${h.status}${h.code ? `/${h.code}` : ""}`] = (c[`${h.status}${h.code ? `/${h.code}` : ""}`] ?? 0) + 1;
  return fmtCounts(c) || "none";
};

async function arm(ctx: Ctx, p: DcProject, lockS: number): Promise<TestResult> {
  const t0 = Date.now();
  const hits: Hit[] = [];
  let stop = false;
  const workers = Array.from({ length: WORKERS }, async () => {
    while (!stop) hits.push(await get(p));
  });
  const samples: { t: number; s: string; aborted: number }[] = [];
  const sampler = (async () => {
    while (!stop) {
      samples.push(await states(ctx, p.ref));
      await sleep(5_000);
    }
  })();

  await sleep(15_000);
  const lockStart = Date.now();
  const lock = await sql(ctx, p.ref, `begin; lock table public.dc_items in access exclusive mode; select pg_sleep(${lockS}); commit;`, (lockS + 60) * 1000);
  const lockEnd = Date.now();
  await sleep(75_000);
  stop = true;
  await Promise.all(workers);
  await sampler;

  const before = hits.filter((h) => h.t < lockStart);
  // A request answered within 4 s after the lock ended may have been queued behind it.
  const during = hits.filter((h) => h.t >= lockStart && h.t < lockEnd + 4_000);
  const after = hits.filter((h) => h.t >= lockEnd + 4_000);
  const p25 = after.filter((h) => h.code === "25P02");
  const maxAborted = Math.max(-1, ...samples.filter((s) => s.t >= lockStart).map((s) => s.aborted));
  const rel = (t: number) => Math.round((t - lockEnd) / 100) / 10;
  return {
    id: "DC06",
    title: `${lockS} s lock on dc_items under ${WORKERS} anon workers`,
    status: lock.error ? "fail" : "info",
    detail:
      `lock query ${lock.status}${lock.error ? ` ${lock.error}` : ""}, held ${Math.round((lockEnd - lockStart) / 100) / 10} s; ` +
      `before ${counts(before)}; during ${counts(during)}; after ${counts(after)}; ` +
      `25P02 after the lock ${p25.length}${p25.length ? ` (first ${rel(p25[0]!.t)} s, last ${rel(p25[p25.length - 1]!.t)} s after it ended)` : ""}; ` +
      `max idle-in-transaction-(aborted) authenticator backends ${maxAborted}`,
    measurements: {
      lock_s: lockS,
      lock_status: lock.status,
      lock_held_s: Math.round((lockEnd - lockStart) / 100) / 10,
      before: counts(before),
      during: counts(during),
      after: counts(after),
      after_25p02: p25.length,
      max_aborted_backends: maxAborted,
      requests: hits.length,
    },
    evidence: redact(`authenticator states (t relative to lock end): ${samples.map((s) => `${rel(s.t)}s ${s.s}`).join(" | ")}`),
  };
}

const mod: TestModule = {
  id: "DC06",
  title: "After a stall of statement timeouts: are pooled connections left aborted (25P02)?",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "DC06");
    if (skip) return skip;
    const out: TestResult[] = [];
    try {
      const p = await ensureProject(ctx);
      await ensureItems(ctx, p);
      // Control first, so anything the 12 s arm leaves behind cannot show up in it.
      for (const lockS of [2, 12]) {
        out.push(await arm(ctx, p, lockS));
        await sleep(15_000);
      }
    } catch (e) {
      out.push({ id: "DC06", title: "DC06", status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};
export default mod;
