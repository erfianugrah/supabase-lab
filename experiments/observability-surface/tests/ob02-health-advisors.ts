/**
 * OB02 - Health Check Advisors: which of the four `log_*_error_rate_high`
 * lints fire on `POST /v2/projects/{ref}/advisors/run` after an induced 5xx
 * load, at what rate and volume, how long after, and how long the answer is
 * cached.
 *
 * Source for the claims under test: the changelog entry
 * https://supabase.com/changelog/50577-health-check-advisors (2026-09-18):
 * four service error-rate checks "read from log data", "results are cached to
 * avoid repeated probing", an empty result means every check ran and found
 * nothing. The lint's own description text (read from the first firing, not
 * from the docs) adds a rule: 5xx for at least 10% of requests across two
 * consecutive five minute periods.
 *
 * Design: one throwaway Pro-org project per ARM, all arms run concurrently, so
 * an arm's traffic never lands in another arm's logs. Every arm waits for the
 * next wall-clock five-minute boundary (UTC), sends traffic at one request per
 * 3 s for a whole number of five-minute buckets, and polls the advisor every
 * 30 s from the first request until the lint has cleared (or for 8 minutes
 * after the traffic stopped if it never fired). Failures are induced with
 * 5xx the service itself returns:
 *   data     POST /rest/v1/rpc/ob_boom - a function raising SQLSTATE PT500
 *            (PostgREST maps `PTxyz` to HTTP xyz). Successes: GET on a table.
 *   auth     POST /auth/v1/admin/users with a BEFORE INSERT trigger on
 *            auth.users that raises (GoTrue answers 500).
 *   storage  object list as anon with a storage.objects SELECT policy that
 *            calls a function that raises (Storage answers 500 DatabaseError).
 *   edge     a function returning 500, and a function that throws.
 * Arms: data at failing share 100 / 50 / 12 / 8 percent; data at 100 percent
 * but one request a minute (volume floor); data failing for ONE bucket only;
 * data answering 404 (a 4xx control); auth, storage, and the two Edge Function
 * shapes at 100 percent.
 *
 * Measured per arm: seconds from the first request to the first lint, seconds
 * after the end of the second bucket, the lint's detail text (percentage and
 * request count it reports, against the count actually sent), the spacing of
 * `observed_at` values across polls (the cache refresh), and seconds from the
 * last failing request to the lint clearing. Raw polls go to
 * evidence/<stamp>/ob02-polls.json (gitignored).
 *
 * Not settled: other lints in the v2 enum (instance_*, db_*), Realtime, the
 * Studio Health tab, projects with real user traffic (the lab sends one request
 * every 3 s), regions other than ap-southeast-1, other plans.
 *
 * Default arms are the first eleven; `OB02_ARMS=a,b,...` selects any arms by id
 * (the ladder and the two-period arms were a second run, the count-versus-share arms a third).
 *
 * DESTRUCTIVE: creates and deletes one project per arm.
 */
import { writeFileSync } from "node:fs";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { type Lint, dropProject, evidencePath, iso, makeProject, runAdvisors, sleep, sql } from "../lib/ob";

const BUCKET_MS = 300_000;
const POLL_MS = 30_000;

type Service = "data" | "auth" | "storage" | "edge_500" | "edge_throw";
interface Arm {
  id: string;
  service: Service;
  /** percent of requests that fail, 0..100 */
  failPct: number;
  /** requests per minute (default 20 = one per 3 s) */
  rpm?: number;
  buckets: number;
  /** failing requests answer 404 instead of 5xx (control) */
  fourxx?: boolean;
  /** when set, every Nth request fails (offset so each bucket gets its share) instead of the percent pattern */
  every?: number;
  /** when set, requests fail only while the traffic is in this bucket (0 = first, 1 = second) */
  failBucket?: number;
}

const ARMS: Arm[] = [
  { id: "data_f100", service: "data", failPct: 100, buckets: 2 },
  { id: "data_f50", service: "data", failPct: 50, buckets: 2 },
  { id: "data_f12", service: "data", failPct: 12, buckets: 2 },
  { id: "data_f8", service: "data", failPct: 8, buckets: 2 },
  { id: "data_f100_1rpm", service: "data", failPct: 100, rpm: 1, buckets: 2 },
  { id: "data_f100_1bucket", service: "data", failPct: 100, buckets: 1 },
  { id: "data_404", service: "data", failPct: 100, buckets: 2, fourxx: true },
  { id: "auth_f100", service: "auth", failPct: 100, buckets: 2 },
  { id: "storage_f100", service: "storage", failPct: 100, buckets: 2 },
  { id: "edge_500_f100", service: "edge_500", failPct: 100, buckets: 2 },
  { id: "edge_throw_f100", service: "edge_throw", failPct: 100, buckets: 2 },
  // ladder below the first run's lowest failing share (8 percent fired against a documented 10 percent)
  { id: "data_every20", service: "data", failPct: 5, every: 20, buckets: 2 },
  { id: "data_every33", service: "data", failPct: 3, every: 33, buckets: 2 },
  { id: "data_every50", service: "data", failPct: 2, every: 50, buckets: 2 },
  { id: "data_every100", service: "data", failPct: 1, every: 100, buckets: 2 },
  // volume floor: five requests per bucket with one failing; one request per bucket, failing
  { id: "data_1rpm_every5", service: "data", failPct: 20, rpm: 1, every: 5, buckets: 2 },
  { id: "data_1perbucket_f100", service: "data", failPct: 100, rpm: 0.2, buckets: 2 },
  // the two-period rule: failures in one bucket only, the other bucket healthy
  { id: "data_fail_b1_ok_b2", service: "data", failPct: 100, buckets: 2, failBucket: 0 },
  { id: "data_ok_b1_fail_b2", service: "data", failPct: 100, buckets: 2, failBucket: 1 },
  // third run: does the rule count failing requests or take a share? (second run: 5 failing of 100 fired,
  // 3 of 100 did not, 1 of 5 did not, 5 of 5 fired in the first run)
  { id: "data_4of100", service: "data", failPct: 4, every: 25, buckets: 2 },
  { id: "data_5of250", service: "data", failPct: 2, rpm: 50, every: 50, buckets: 2 },
  { id: "data_6of600", service: "data", failPct: 1, rpm: 120, every: 100, buckets: 2 },
  { id: "data_every20_rep", service: "data", failPct: 5, every: 20, buckets: 2 },
  { id: "data_every33_rep", service: "data", failPct: 3, every: 33, buckets: 2 },
];
const FIRST_RUN = ARMS.slice(0, 11).map((a) => a.id);

const LINT_FOR: Record<Service, string> = {
  data: "log_data_api_error_rate_high",
  auth: "log_auth_error_rate_high",
  storage: "log_storage_error_rate_high",
  edge_500: "log_edge_function_error_rate_high",
  edge_throw: "log_edge_function_error_rate_high",
};

const FN_500 = `Deno.serve(() => new Response("ob induced 500", { status: 500 }));`;
const FN_THROW = `Deno.serve(() => { throw new Error("ob induced throw"); });`;

interface PollRow {
  t: number;
  status: number;
  lints: Lint[];
}
interface ArmOut {
  arm: Arm;
  setupError?: string;
  sent: number;
  sentFail: number;
  statusCounts: Record<string, number>;
  tStart: number;
  tTrafficEnd: number;
  polls: PollRow[];
  healthyMs: number;
}

async function setup(ctx: Ctx, arm: Arm): Promise<void> {
  if (arm.service === "data") {
    const r = await sql(
      ctx,
      `create table public.ob_probe(id int primary key); insert into public.ob_probe values (1);
       alter table public.ob_probe enable row level security;
       create policy ob_anon_read on public.ob_probe for select to anon using (true);
       create function public.ob_boom() returns void language plpgsql as $$ begin raise sqlstate 'PT500' using message = 'ob induced'; end $$;
       grant execute on function public.ob_boom() to anon;`,
    );
    if (r.status >= 300) throw new Error(`data setup: ${r.error}`);
  } else if (arm.service === "auth") {
    const r = await sql(
      ctx,
      `create function public.ob_block() returns trigger language plpgsql as $$ begin raise exception 'ob induced'; end $$;
       create trigger ob_t before insert on auth.users for each row execute function public.ob_block();`,
    );
    if (r.status >= 300) throw new Error(`auth setup: ${r.error}`);
  } else if (arm.service === "storage") {
    const r = await sql(
      ctx,
      `insert into storage.buckets (id, name, public) values ('ob-b', 'ob-b', false);
       create function public.ob_boom_bool() returns boolean language plpgsql as $$ begin raise exception 'ob induced'; end $$;
       grant execute on function public.ob_boom_bool() to anon;
       create policy ob_pol on storage.objects for select to anon using (bucket_id = 'ob-b' and public.ob_boom_bool());`,
    );
    if (r.status >= 300) throw new Error(`storage setup: ${r.error}`);
    const up = await fetch(`https://${ctx.apiHost}/storage/v1/object/ob-b/a.txt`, {
      method: "POST",
      headers: { apikey: ctx.serviceKey!, authorization: `Bearer ${ctx.serviceKey}`, "content-type": "text/plain" },
      body: "hello",
    });
    if (up.status >= 300) throw new Error(`storage upload ${up.status}`);
  } else {
    const slug = arm.service === "edge_500" ? "ob-fail" : "ob-throw";
    const src = arm.service === "edge_500" ? FN_500 : FN_THROW;
    const d = await deployViaApi(ctx, slug, [{ name: "index.ts", content: src }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
    if (d.status >= 300) throw new Error(`deploy ${slug}: HTTP ${d.status} ${d.error}`);
    // the first requests after a deploy answer 404 until the function is routed; wait it out
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`https://${ctx.apiHost}/functions/v1/${slug}`, { headers: { apikey: ctx.anonKey! } }).catch(() => null);
      if (r && r.status !== 404) break;
      await sleep(3000);
    }
  }
}

/** One request of the arm's service. Returns the HTTP status (0 on a network error). */
async function send(ctx: Ctx, arm: Arm, failing: boolean, n: number): Promise<number> {
  const base = `https://${ctx.apiHost}`;
  const anon = { apikey: ctx.anonKey!, authorization: `Bearer ${ctx.anonKey}`, "content-type": "application/json" };
  const svc = { apikey: ctx.serviceKey!, authorization: `Bearer ${ctx.serviceKey}`, "content-type": "application/json" };
  try {
    let res: Response;
    if (arm.service === "data") {
      if (failing && arm.fourxx) res = await fetch(`${base}/rest/v1/ob_missing`, { headers: anon });
      else if (failing) res = await fetch(`${base}/rest/v1/rpc/ob_boom`, { method: "POST", headers: anon, body: "{}" });
      else res = await fetch(`${base}/rest/v1/ob_probe?limit=1`, { headers: anon });
    } else if (arm.service === "auth") {
      res = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers: svc, body: JSON.stringify({ email: `ob${n}-${Date.now()}@example.com`, password: "Passw0rd!xx", email_confirm: true }) });
    } else if (arm.service === "storage") {
      res = await fetch(`${base}/storage/v1/object/list/ob-b`, { method: "POST", headers: anon, body: JSON.stringify({ prefix: "", limit: 10 }) });
    } else {
      const slug = arm.service === "edge_500" ? "ob-fail" : "ob-throw";
      res = await fetch(`${base}/functions/v1/${slug}`, { method: "POST", headers: anon, body: "{}" });
    }
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

async function pollOnce(ctx: Ctx): Promise<{ status: number; lints: Lint[] }> {
  let r = await runAdvisors(ctx);
  for (let k = 0; k < 4 && r.status === 429; k++) {
    await sleep(Math.max(15_000, Number(r.retryAfter || 0) * 1000));
    r = await runAdvisors(ctx);
  }
  return { status: r.status, lints: r.lints };
}

async function runArm(ctx: Ctx, arm: Arm, stagger: number): Promise<ArmOut> {
  const out: ArmOut = { arm, sent: 0, sentFail: 0, statusCounts: {}, tStart: 0, tTrafficEnd: 0, polls: [], healthyMs: -1 };
  let ref = "";
  try {
    await sleep(stagger);
    const proj = await makeProject(ctx, `o2-${arm.id.replace(/_/g, "").slice(0, 10)}`);
    ref = proj.ref;
    out.healthyMs = proj.healthyMs;
    const pc = proj.ctx;
    await setup(pc, arm);

    // baseline: an empty result, then a second call straight after (cache)
    out.polls.push({ t: Date.now(), ...(await pollOnce(pc)) });
    await sleep(1000);
    out.polls.push({ t: Date.now(), ...(await pollOnce(pc)) });

    // align to the next UTC five-minute boundary
    const now = Date.now();
    out.tStart = Math.ceil((now + 20_000) / BUCKET_MS) * BUCKET_MS + 2_000;
    out.tTrafficEnd = out.tStart + arm.buckets * BUCKET_MS - 2_000;
    const gapMs = 60_000 / (arm.rpm ?? 20);
    await sleep(out.tStart - now);

    let nextSend = out.tStart;
    let nextPoll = out.tStart;
    let fired = false;
    let i = 0;
    const hardStop = out.tTrafficEnd + 14 * 60_000;
    while (Date.now() < hardStop) {
      const t = Date.now();
      if (t >= nextPoll) {
        nextPoll = t + POLL_MS;
        const p = await pollOnce(pc);
        out.polls.push({ t, ...p });
        const has = p.lints.some((l) => l.name === LINT_FOR[arm.service]);
        if (has) fired = true;
        if (fired && !has && t > out.tTrafficEnd) break;
        if (!fired && t > out.tTrafficEnd + 8 * 60_000) break;
      }
      if (t >= nextSend && t < out.tTrafficEnd) {
        nextSend += gapMs;
        const bucket = Math.floor((t - out.tStart) / BUCKET_MS);
        let failing = arm.every ? (i + Math.floor(arm.every / 2)) % arm.every === 0 : Math.floor(((i + 1) * arm.failPct) / 100) > Math.floor((i * arm.failPct) / 100) || arm.failPct >= 100;
        if (arm.failBucket !== undefined && bucket !== arm.failBucket) failing = false;
        i++;
        void send(pc, arm, failing, i).then((s) => {
          out.sent++;
          if (failing) out.sentFail++;
          out.statusCounts[String(s)] = (out.statusCounts[String(s)] ?? 0) + 1;
        });
      }
      await sleep(250);
    }
  } catch (e) {
    out.setupError = e instanceof Error ? e.message : String(e);
  } finally {
    await dropProject(ctx, ref);
  }
  return out;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : -1);

function summarise(o: ArmOut): TestResult {
  const lintName = LINT_FOR[o.arm.service];
  const first = o.polls.findIndex((p) => p.lints.some((l) => l.name === lintName));
  const firedPoll = first >= 0 ? o.polls[first] : undefined;
  const lint = firedPoll?.lints.find((l) => l.name === lintName);
  const clearedPoll = firedPoll ? o.polls.find((p) => p.t > firedPoll.t && p.t > o.tTrafficEnd && !p.lints.some((l) => l.name === lintName)) : undefined;
  const obs = [...new Set(o.polls.flatMap((p) => p.lints.filter((l) => l.name === lintName).map((l) => l.observed_at ?? "")))]
    .filter(Boolean)
    .map((s) => Date.parse(s))
    .sort((a, b) => a - b);
  const gaps = obs.slice(1).map((v, i) => Math.round((v - obs[i]!) / 1000));
  const otherLints = [...new Set(o.polls.flatMap((p) => p.lints.map((l) => l.name)).filter((n) => n !== lintName))];
  const m: Record<string, number | string> = {
    sent: o.sent,
    sent_failing: o.sentFail,
    status_counts: JSON.stringify(o.statusCounts),
    baseline_lints: o.polls.slice(0, 2).map((p) => p.lints.length).join(","),
    fired: firedPoll ? "yes" : "no",
    first_lint_after_start_s: firedPoll ? Math.round((firedPoll.t - o.tStart) / 1000) : -1,
    first_lint_after_traffic_end_s: firedPoll ? Math.round((firedPoll.t - o.tTrafficEnd) / 1000) : -1,
    lint_level: lint?.level ?? "-",
    lint_detail: (lint?.detail ?? "-").replace(/\s+/g, " ").slice(0, 200),
    lint_description: (lint?.description ?? "-").slice(0, 160),
    observed_at_distinct: obs.length,
    observed_at_gap_median_s: median(gaps),
    cleared_after_traffic_end_s: clearedPoll ? Math.round((clearedPoll.t - o.tTrafficEnd) / 1000) : -1,
    other_lints_seen: otherLints.join(",") || "none",
    polls: o.polls.length,
    project_healthy_ms: o.healthyMs,
  };
  return {
    id: `OB02 ${o.arm.id}`,
    title: `OB02: ${o.arm.id}`,
    status: o.setupError ? "fail" : "info",
    detail: o.setupError ?? `fired=${m.fired} first=${m.first_lint_after_start_s}s after start, cleared=${m.cleared_after_traffic_end_s}s after end`,
    measurements: m,
  };
}

const mod: TestModule = {
  id: "OB02",
  title: "Health Check Advisors: error-rate lints after induced 5xx, per service",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const only = process.env.OB02_ARMS?.split(",");
    const arms = only ? ARMS.filter((a) => only.includes(a.id)) : ARMS.filter((a) => FIRST_RUN.includes(a.id));
    const outs = await Promise.all(arms.map((a, i) => runArm(ctx, a, i * 4_000)));
    writeFileSync(evidencePath("ob02-polls.json"), JSON.stringify(outs.map((o) => ({ ...o, polls: o.polls.map((p) => ({ ...p, t: iso(p.t) })) })), null, 1));
    return outs.map(summarise);
  },
};
export default mod;
