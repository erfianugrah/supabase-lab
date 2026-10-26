/**
 * AR05 - password grants per second by compute size, with the token limiter
 * out of the way, and whether Auth slows when Postgres is CPU-saturated.
 *
 * Competing hypotheses:
 *   - Grant throughput scales with compute: saturation grants/s rises from
 *     Small to Large to 2XL roughly with the vCPU count, because a password
 *     grant is one bcrypt compare (CPU) plus a few writes.
 *   - It does not: a fixed Auth pool (`db_max_pool_size` 10 on every tier,
 *     AR04) or a per-request cost outside the instance caps it, and the
 *     sizes plateau at the same rate.
 *   Saturation is read from a closed-loop concurrency sweep (PVLAB_AR05_CONC,
 *   default 1,4,16,64,128, PVLAB_AR05_STEP_S seconds each); node CPU from the
 *   project's metrics endpoint where a fresh snapshot exists.
 *
 * Placement probe (PVLAB_AR05_PLACEMENT=1): sequential latency of
 * /auth/v1/health (no DB), a grant for an email with no account (one DB
 * lookup, no bcrypt) and a valid grant (bcrypt + writes), and 20 s at c=16,
 * before and while 2 x vCPU sessions run `select count(*) from
 * generate_series(...)` through a service_role RPC. If Auth shares the
 * instance's CPU, the bcrypt path slows by about as much as the CPU is
 * oversubscribed; if it only shares the database, the lookup path slows and
 * health does not.
 *
 * Size: PVLAB_AR05_RESIZE_TO (e.g. ci_large) resizes first; PVLAB_AR05_LABEL
 * names the size in the ids. The limiter is moved out of the way with
 * rate_limit_token_refresh = PVLAB_AR05_LIMIT (default 1000000) and checked
 * with 300 concurrent cheap grants.
 *
 * DESTRUCTIVE: creates or reuses the project (lib/ar-project.ts), resizes,
 * PATCHes auth config, creates PVLAB_AR05_USERS users.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import {
  authConfig,
  cpuPct,
  type CpuSnap,
  gotrueCores,
  createUsers,
  ensureProject,
  errText,
  fmtCounts,
  health,
  type Hit,
  nodeCpu,
  passwordGrant,
  patchAndSettle,
  pctl,
  rateLimitFields,
  redact,
  resize,
  skipWithoutPro,
  sleep,
  sql,
  type ArProject,
  type TestUser,
} from "../lib/ar-project.js";

const CONC = (process.env.PVLAB_AR05_CONC || "1,4,16,64,128").split(",").map(Number);
const STEP_S = Number(process.env.PVLAB_AR05_STEP_S || 40);
const LIMIT = Number(process.env.PVLAB_AR05_LIMIT || 1_000_000);
const NUSERS = Number(process.env.PVLAB_AR05_USERS || 128);
const RESIZE_TO = process.env.PVLAB_AR05_RESIZE_TO || "";
const LABEL = process.env.PVLAB_AR05_LABEL || "start";
const PLACEMENT = process.env.PVLAB_AR05_PLACEMENT === "1";
// 300M rows ran past a gateway limit on Small (2026-10-26: 4 calls, all 503);
// shorter calls keep each burner looping.
const BURN_N = Number(process.env.PVLAB_AR05_BURN_N || 60_000_000);
const SWEEP = process.env.PVLAB_AR05_SWEEP !== "0";

interface Step {
  c: number;
  hits: Hit[];
  durS: number;
  cpu: number;
}

/** Closed loop: c workers, each signs in its own user back to back for durS. */
async function closedLoop(p: ArProject, users: TestUser[], c: number, durS: number): Promise<{ hits: Hit[]; durS: number }> {
  const hits: Hit[] = [];
  const t0 = performance.now();
  const end = t0 + durS * 1000;
  await Promise.all(
    Array.from({ length: c }, async (_, w) => {
      const u = users[w % users.length]!;
      while (performance.now() < end) hits.push(await passwordGrant(p, u.email, u.password, t0));
    }),
  );
  return { hits, durS: (performance.now() - t0) / 1000 };
}

/**
 * Sample the metrics snapshot every 5 s while `op` runs; node busy %, Auth
 * process cores and Auth pool waits from the first and last distinct snapshots.
 */
async function withCpu<T>(p: ArProject, op: () => Promise<T>): Promise<{ r: T; cpu: number; snaps: number; gotrue: number; waits: number; waitMs: number }> {
  const snaps: CpuSnap[] = [];
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const s = await nodeCpu(p);
      if (s && (!snaps.length || snaps.at(-1)!.busy !== s.busy)) snaps.push(s);
      await sleep(5_000);
    }
  })();
  const r = await op();
  done = true;
  await sampler;
  const a = snaps[0] ?? null;
  const b = snaps.length >= 2 ? snaps.at(-1)! : null;
  return {
    r,
    cpu: b ? cpuPct(a, b) : -1,
    snaps: snaps.length,
    gotrue: b ? gotrueCores(a, b) : -1,
    waits: a && b && a.poolWaits >= 0 ? b.poolWaits - a.poolWaits : -1,
    waitMs: a && b && a.poolWaitMs >= 0 ? Math.round(b.poolWaitMs - a.poolWaitMs) : -1,
  };
}

function summarise(hits: Hit[], durS: number) {
  const st: Record<string, number> = {};
  for (const h of hits) st[String(h.status)] = (st[String(h.status)] ?? 0) + 1;
  const ok = hits.filter((h) => h.status === 200);
  return {
    statuses: fmtCounts(st),
    grants_per_s: Math.round((10 * ok.length) / durS) / 10,
    p50_ms: pctl(ok.map((h) => h.ms), 50),
    p95_ms: pctl(ok.map((h) => h.ms), 95),
    n5xx: hits.filter((h) => h.status >= 500).length,
    n429: st["429"] ?? 0,
    n0: st["0"] ?? 0,
  };
}

async function seqLatency(make: () => Promise<Hit>, n: number): Promise<{ p50: number; p95: number; statuses: string }> {
  const hs: Hit[] = [];
  for (let i = 0; i < n; i++) hs.push(await make());
  const st: Record<string, number> = {};
  for (const h of hs) st[String(h.status)] = (st[String(h.status)] ?? 0) + 1;
  return { p50: pctl(hs.map((h) => h.ms), 50), p95: pctl(hs.map((h) => h.ms), 95), statuses: fmtCounts(st) };
}

const BURN_SQL = `
create or replace function public.ar_burn(n bigint) returns bigint
  language sql set statement_timeout = '120s' as $$ select count(*) from generate_series(1, n) $$;
revoke execute on function public.ar_burn(bigint) from public, anon, authenticated;
grant execute on function public.ar_burn(bigint) to service_role;
notify pgrst, 'reload schema';`;

const mod: TestModule = {
  id: "AR05",
  title: "Auth password grants per second by compute size; Auth under a CPU-saturated Postgres",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "AR05");
    if (skip) return skip;
    const out: TestResult[] = [];
    const id = (s: string) => `AR05.${LABEL}.${s}`;
    let p: ArProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "AR05", title: this.title, status: "fail", detail: `provision: ${errText(e)}` }];
    }
    try {
      if (RESIZE_TO) {
        const r = await resize(ctx, p, RESIZE_TO);
        out.push({ id: id("resize"), title: `resize to ${RESIZE_TO}`, status: r.settledS >= 0 ? "info" : "fail", detail: `${r.status} ${r.text}; settled ${r.settledS} s; max_connections ${r.maxConn}`, measurements: { settled_s: r.settledS, max_connections: r.maxConn } });
        if (r.settledS < 0) return out;
      }
      const mc = await sql(ctx, p.ref, "select current_setting('max_connections') as mc, version() as v");
      const cpu0 = await nodeCpu(p);
      const st = await patchAndSettle(ctx, p, { rate_limit_token_refresh: LIMIT }, 20);
      const cfg = rateLimitFields(await authConfig(ctx, p));
      const pool = String((await authConfig(ctx, p)).db_max_pool_size ?? "");
      const check = await Promise.all(Array.from({ length: 300 }, () => passwordGrant(p, `ar05-nobody-${crypto.randomUUID().slice(0, 8)}@example.com`, "x-Aa1-not-real")));
      const n429 = check.filter((h) => h.status === 429).length;
      out.push({
        id: id("setup"),
        title: `setup on ${LABEL}: limiter raised, size facts`,
        status: n429 === 0 ? "info" : "fail",
        detail: `PATCH rate_limit_token_refresh=${LIMIT} ${st.status}; 300 concurrent cheap grants gave ${n429} x 429; max_connections ${String(mc.rows?.[0]?.mc)}; node CPUs ${cpu0?.ncpu ?? -1}; auth db_max_pool_size ${pool}`,
        measurements: { limit: LIMIT, patch_status: st.status, check_429: n429, max_connections: String(mc.rows?.[0]?.mc ?? ""), ncpu: cpu0?.ncpu ?? -1, db_max_pool_size: pool, pg: String(mc.rows?.[0]?.v ?? "").split(" on ")[0] ?? "", ...cfg },
      });
      if (st.status >= 300) return out;

      const { users, failed } = await createUsers(p, `${LABEL}${Date.now()}`, NUSERS);
      if (failed) throw new Error(`user create failed for ${failed} of ${NUSERS}`);
      const rtt = await seqLatency(() => health(p), 20);
      out.push({ id: id("rtt"), title: "GET /auth/v1/health from the client (no DB, no bcrypt)", status: "info", detail: `p50 ${rtt.p50} ms p95 ${rtt.p95} ms (${rtt.statuses})`, measurements: { p50_ms: rtt.p50, p95_ms: rtt.p95 } });

      // Warm-up: one grant per user (first sign-in is not the steady state).
      await closedLoop(p, users, 16, 5);

      const steps: Step[] = [];
      for (const c of SWEEP ? CONC : []) {
        const { r, cpu, snaps, gotrue, waits, waitMs } = await withCpu(p, () => closedLoop(p, users, c, STEP_S));
        const s = summarise(r.hits, r.durS);
        steps.push({ c, hits: r.hits, durS: r.durS, cpu });
        out.push({
          id: id(`c${String(c).padStart(3, "0")}`),
          title: `${LABEL}: closed loop c=${c} for ${STEP_S} s`,
          status: "info",
          detail: `${s.grants_per_s} grants/s, p50 ${s.p50_ms} ms, p95 ${s.p95_ms} ms; ${s.statuses}; node CPU ${cpu}%, Auth process ${gotrue} cores, Auth pool waits ${waits} (${waitMs} ms) over ${snaps} snapshots`,
          measurements: { c, ...s, node_cpu_pct: cpu, gotrue_cores: gotrue, auth_pool_waits: waits, auth_pool_wait_ms: waitMs, cpu_snapshots: snaps, dur_s: Math.round(r.durS) },
        });
        ctx.log(`AR05 ${LABEL} c=${c}: ${s.grants_per_s}/s p50 ${s.p50_ms} ${s.statuses} cpu ${cpu} gotrue ${gotrue} waits ${waits}`);
        await sleep(5_000);
      }

      if (PLACEMENT) {
        const setup = await sql(ctx, p.ref, BURN_SQL);
        if (setup.error) throw new Error(`burn setup: ${setup.error}`);
        await sleep(5_000);
        const nobody = () => passwordGrant(p, `ar05-nobody-${crypto.randomUUID().slice(0, 8)}@example.com`, "x-Aa1-not-real");
        const valid = users[0]!;
        const measure = async () => ({
          health: await seqLatency(() => health(p), 20),
          lookup: await seqLatency(nobody, 20),
          grant: await seqLatency(() => passwordGrant(p, valid.email, valid.password), 20),
          c16: await withCpu(p, () => closedLoop(p, users, 16, 20)),
        });
        const before = await measure();
        const ncpu = cpu0?.ncpu && cpu0.ncpu > 0 ? cpu0.ncpu : 2;
        const burners = 2 * ncpu;
        let burning = true;
        let burnCalls = 0;
        const burnStatuses: Record<string, number> = {};
        const burnLoops = Array.from({ length: burners }, async () => {
          while (burning) {
            const r = await fetch(`https://${p.host}/rest/v1/rpc/ar_burn`, {
              method: "POST",
              headers: { apikey: p.service, Authorization: `Bearer ${p.service}`, "Content-Type": "application/json" },
              body: JSON.stringify({ n: BURN_N }),
              signal: AbortSignal.timeout(150_000),
            }).catch(() => null);
            burnCalls++;
            const k = String(r?.status ?? 0);
            burnStatuses[k] = (burnStatuses[k] ?? 0) + 1;
            await r?.text().catch(() => "");
          }
        });
        await sleep(10_000);
        const act = await sql(ctx, p.ref, "select count(*)::int as n from pg_stat_activity where state = 'active' and (query ilike '%ar_burn%' or query ilike '%generate_series%') and pid <> pg_backend_pid()");
        const during = await withCpu(p, async () => measure());
        burning = false;
        await Promise.all(burnLoops);
        const row = (k: string, b: { p50: number; p95: number; statuses: string }, d: { p50: number; p95: number; statuses: string }) => ({
          [`${k}_p50_before`]: b.p50,
          [`${k}_p50_during`]: d.p50,
          [`${k}_p95_before`]: b.p95,
          [`${k}_p95_during`]: d.p95,
        });
        const sb = summarise(before.c16.r.hits, before.c16.r.durS);
        const sd = summarise(during.r.c16.r.hits, during.r.c16.r.durS);
        out.push({
          id: id("placement"),
          title: `${LABEL}: Auth latency before and while ${burners} sessions burn Postgres CPU`,
          status: "info",
          detail:
            `health p50 ${before.health.p50} -> ${during.r.health.p50} ms; no-account grant p50 ${before.lookup.p50} -> ${during.r.lookup.p50} ms; ` +
            `valid grant p50 ${before.grant.p50} -> ${during.r.grant.p50} ms; c=16 ${sb.grants_per_s} -> ${sd.grants_per_s} grants/s (p50 ${sb.p50_ms} -> ${sd.p50_ms} ms); ` +
            `node CPU before ${before.c16.cpu}% during ${during.cpu}%; active burners seen ${String(act.rows?.[0]?.n ?? act.error)}; burn calls ${fmtCounts(burnStatuses)}`,
          measurements: {
            burners,
            active_burners_seen: String(act.rows?.[0]?.n ?? -1),
            ...row("health", before.health, during.r.health),
            ...row("lookup", before.lookup, during.r.lookup),
            ...row("grant", before.grant, during.r.grant),
            c16_gps_before: sb.grants_per_s,
            c16_gps_during: sd.grants_per_s,
            c16_p50_before: sb.p50_ms,
            c16_p50_during: sd.p50_ms,
            cpu_before_c16: before.c16.cpu,
            cpu_during: during.cpu,
            gotrue_cores_before_c16: before.c16.gotrue,
            gotrue_cores_during_all: during.gotrue,
            burn_statuses: fmtCounts(burnStatuses),
            burn_calls: burnCalls,
          },
        });
      }
    } catch (e) {
      out.push({ id: "AR05", title: this.title, status: "fail", detail: redact(`threw: ${errText(e)}`) });
    }
    return out;
  },
};

export default mod;
