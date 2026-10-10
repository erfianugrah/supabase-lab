/**
 * ER02 - an Edge Function canary: version drift after a redeploy, whether
 * supabase-js functions.invoke retries a 503 the function itself returns, and
 * the latency distribution over a sampling window.
 *
 * One self-provisioned Pro-org project, one canary function (`er-canary`) that
 * returns the build hash baked in at deploy time, an isolate id, and can answer
 * with an injected status. Results:
 *
 *   ER02-setup   project, canary live, RPC twin created, vantage recorded
 *   ER02-c1..cN  one redeploy cycle each: build A -> build B via the Management
 *                API deploy path, 4 concurrent pollers sampling the canary
 *                until the new build has been the only answer for a settle
 *                period. Records time to first new-build answer, time of the
 *                last old-build answer, and old-after-new count (mixed window).
 *   ER02-drift   summary across cycles
 *   ER02-retry-* supabase-js `functions.invoke` against ?fail=<status>: client
 *                attempts (counted in a fetch wrapper), the server's own count of
 *                that request id (x-er-seen), the error class, elapsed time
 *   ER02-lat     a sampling window at 1 request/s to the function and 1/s to an
 *                RPC twin of the same logic: p50/p95/p99/max, per-30 s bucket
 *                p95, isolates seen, and how often a "p95 > 2x baseline" rule
 *                would have fired
 *
 * Vantage: this machine's egress; the Cloudflare trace colo and country are
 * recorded, the address is not. Deploy path: Management API multipart (not the
 * CLI). Self-provisions one project and deletes it in finally.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createClient, FunctionsHttpError, FunctionsRelayError } from "@supabase/supabase-js";
import supabaseJsPkg from "@supabase/supabase-js/package.json" with { type: "json" };
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { PREFIX, createProject, deleteProject, percentile, projectCtx, revealKeys, sleep, waitProjectReady } from "../lib/er";
import { analyseDrift, bucketP95, type Sample } from "../lib/drift";

/**
 * functions-js is a dependency of supabase-js, so it is resolved from where
 * supabase-js itself resolves it: the version recorded is the one `invoke` ran
 * on, and the root typecheck needs no extra install.
 */
const functionsJsVersion = (): string => {
  const fromSupabaseJs = createRequire(createRequire(import.meta.url).resolve("@supabase/supabase-js"));
  return (fromSupabaseJs("@supabase/functions-js/package.json") as { version: string }).version;
};

const DIR = join(import.meta.dir, "..");
const SLUG = "er-canary";
const CYCLES = Number(process.env.ER_CYCLES ?? 5);
const WINDOW_S = Number(process.env.ER_WINDOW_S ?? 600);
const POLLERS = 4;
const SETTLE_MS = 20_000;
const MIN_WATCH_MS = 30_000;
const MAX_WATCH_MS = 180_000;

function buildHash(template: string, nonce: string): string {
  return createHash("sha256").update(template).update(nonce).digest("hex").slice(0, 12);
}

async function vantage(): Promise<string> {
  try {
    const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(8_000) })).text();
    const kv = Object.fromEntries(t.trim().split("\n").map((l) => l.split("=") as [string, string]));
    return `colo=${kv.colo ?? "?"} loc=${kv.loc ?? "?"}`;
  } catch {
    return "unknown";
  }
}

/** A sample whose `t` is an absolute epoch ms until the module re-bases it to the deploy call. */
type Obs = Sample & { age: number; served: number };

async function oneInvoke(url: string, headers: Record<string, string>): Promise<Obs> {
  const s = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let build = "";
    let isolate = "";
    let age = -1;
    let served = -1;
    try {
      const j = JSON.parse(text) as { build?: string; isolate?: string; age_ms?: number; served?: number };
      build = j.build ?? "";
      isolate = j.isolate ?? "";
      age = j.age_ms ?? -1;
      served = j.served ?? -1;
    } catch {
      /* non-JSON */
    }
    return { t: Date.now(), status: res.status, build, isolate, ms: Math.round(performance.now() - s), age, served };
  } catch {
    return { t: Date.now(), status: 0, build: "", isolate: "", ms: Math.round(performance.now() - s), age: -1, served: -1 };
  }
}

const mod: TestModule = {
  id: "ER02",
  title: "Edge Function canary: redeploy drift, functions.invoke retry on 503, latency window",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(base: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const org = base.orgs.pro ?? "";
    if (!org) return [{ id: "ER02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    let ctx = base;
    try {
      const created = await createProject(base, org, "er02");
      ref = created.ref;
      if (created.status !== 201 || !ref) return [{ id: "ER02", title: this.title, status: "fail", detail: `create HTTP ${created.status}: ${created.text}` }];
      ctx = projectCtx(base, ref);
      const ready = await waitProjectReady(ctx, ref);
      if (!ready.ok) throw new Error(`project not ready: ${ready.status}`);
      const keys = await revealKeys(ctx);
      const template = await readFile(join(DIR, "functions/canary.ts"), "utf8");
      const url = `https://${ctx.apiHost}/functions/v1/${SLUG}`;
      const hdr = { apikey: keys.publishable };

      const deploy = async (nonce: string) => {
        const build = buildHash(template, nonce);
        const src = template.replace("__BUILD__", build);
        const d = await deployViaApi(ctx, SLUG, [{ name: "index.ts", content: src }], { entrypoint_path: "index.ts", name: SLUG, verify_jwt: false });
        return { build, status: d.status, ms: d.ms, version: d.version ?? -1, error: d.error };
      };

      // RPC twin of the canary logic, for the fallback-path latency comparison.
      const fn1 = await sql(ctx, `create or replace function public.er_canary() returns json language sql stable as $$ select json_build_object('build', 'rpc', 'now', now()) $$`);
      const fn2 = await sql(ctx, `grant execute on function public.er_canary() to anon, authenticated; notify pgrst, 'reload schema'`);

      // server-side witness for the retry cases: one row per request the canary receives with ?fail=
      const hitsTbl = await sql(ctx, "create table if not exists public.er_hits (probe text not null, isolate text, at timestamptz default now())");
      const hitsRls = await sql(ctx, "alter table public.er_hits enable row level security");

      // ---- initial deploy, wait until it answers ----
      const first = await deploy(`init-${Date.now()}`);
      let live = false;
      const tLive = Date.now();
      for (let i = 0; i < 40 && !live; i++) {
        const o = await oneInvoke(url, hdr);
        live = o.status === 200 && o.build === first.build;
        if (!live) await sleep(3_000);
      }
      const where = await vantage();
      out.push({
        id: "ER02-setup",
        title: "ER02 setup: project, canary live, RPC twin, vantage",
        status: live && fn1.status < 300 && fn2.status < 300 ? "pass" : "fail",
        detail: `canary answered ${live ? "yes" : "no"} ${Math.round((Date.now() - tLive) / 1000)}s after the first deploy; vantage ${where}`,
        measurements: {
          vantage: where,
          project_ready_s: ready.seconds,
          first_deploy_status: first.status,
          first_deploy_ms: first.ms,
          supabase_js_version: (supabaseJsPkg as { version: string }).version,
          functions_js_version: functionsJsVersion(),
          rpc_twin_status: `${fn1.status}/${fn2.status}`,
          hits_table_status: `${hitsTbl.status}/${hitsRls.status}`,
        },
      });
      if (!live) throw new Error("canary never answered after the first deploy");

      // ---- redeploy cycles ----
      let prev = first.build;
      const cycleDrift: ReturnType<typeof analyseDrift>[] = [];
      const postDeployMs: number[] = [];
      const preDeployMs: number[] = [];
      for (let c = 1; c <= CYCLES; c++) {
        const raw: Obs[] = []; // t = absolute epoch ms at response time
        let stop = false;
        const pollers = Array.from({ length: POLLERS }, async () => {
          while (!stop) {
            raw.push(await oneInvoke(url, hdr));
            await sleep(100);
          }
        });
        await sleep(3_000); // pre-deploy baseline of the old build
        const d = await deploy(`c${c}-${Date.now()}`);
        const tDeploy = Date.now(); // the moment the deploy API call returned
        const watchStart = Date.now();
        // settle: the new build is the only answer for SETTLE_MS, after at least MIN_WATCH_MS
        while (Date.now() - watchStart < MAX_WATCH_MS) {
          await sleep(1_000);
          const recent = raw.filter((s) => s.t > Date.now() - SETTLE_MS && s.t >= tDeploy);
          const settled = Date.now() - watchStart >= MIN_WATCH_MS && recent.length >= 20 && recent.every((s) => s.build === d.build && s.status === 200);
          if (settled) break;
        }
        stop = true;
        await Promise.all(pollers);
        // re-base: t is now ms relative to the deploy call returning (negative = before)
        const samples: Sample[] = raw.map((s) => ({ ...s, t: s.t - tDeploy }));
        const post = samples.filter((s) => s.t >= 0);
        const drift = analyseDrift(post, prev, d.build);
        cycleDrift.push(drift);
        postDeployMs.push(...post.filter((s) => s.t < 10_000 && s.status === 200).map((s) => s.ms));
        preDeployMs.push(...samples.filter((s) => s.t < 0 && s.status === 200).map((s) => s.ms));
        const settledAt = post.at(-1)?.t ?? -1;
        const preBuilds = new Set(samples.filter((s) => s.t < 0).map((s) => s.build));
        out.push({
          id: `ER02-c${c}`,
          title: `ER02 redeploy cycle ${c}: build ${prev.slice(0, 6)} -> ${d.build.slice(0, 6)}`,
          status: d.status < 300 && drift.newBuildFirstMs >= 0 ? "pass" : "fail",
          detail: `deploy API ${d.status} in ${d.ms}ms (function version ${d.version}); first new-build answer ${drift.newBuildFirstMs}ms after the deploy call returned, last old-build answer ${drift.oldBuildLastMs}ms, ${drift.oldAfterFirstNew} old-build answers after the first new one`,
          measurements: {
            deploy_status: d.status,
            deploy_ms: d.ms,
            function_version: d.version,
            first_new_ms: drift.newBuildFirstMs,
            last_old_ms: drift.oldBuildLastMs,
            mixed_window_ms: drift.mixedWindowMs,
            old_after_first_new: drift.oldAfterFirstNew,
            non_200: drift.nonOk,
            samples: drift.samples,
            isolates_new: drift.isolatesNew,
            isolates_old: drift.isolatesOld,
            observed_until_ms: settledAt,
            pollers: POLLERS,
            pre_deploy_samples: samples.filter((s) => s.t < 0).length,
            pre_deploy_builds_seen: preBuilds.size,
          },
        });
        prev = d.build;
      }
      const firstNew = cycleDrift.map((d) => d.newBuildFirstMs).filter((v) => v >= 0);
      const lastOld = cycleDrift.map((d) => d.oldBuildLastMs).filter((v) => v >= 0);
      out.push({
        id: "ER02-drift",
        title: "ER02 drift summary across redeploy cycles",
        status: firstNew.length === CYCLES ? "pass" : "fail",
        detail: `${CYCLES} redeploys with ${POLLERS} concurrent pollers; ${cycleDrift.filter((d) => d.oldAfterFirstNew > 0).length} of ${CYCLES} cycles served the old build after the first new-build answer`,
        measurements: {
          cycles: CYCLES,
          first_new_ms_min: Math.min(...firstNew),
          first_new_ms_max: Math.max(...firstNew),
          first_new_ms_median: percentile(firstNew, 50),
          last_old_ms_max: lastOld.length ? Math.max(...lastOld) : -1,
          cycles_with_old_after_new: cycleDrift.filter((d) => d.oldAfterFirstNew > 0).length,
          non_200_total: cycleDrift.reduce((a, d) => a + d.nonOk, 0),
          pre_deploy_p95_ms: percentile(preDeployMs, 95),
          first_10s_after_deploy_p95_ms: percentile(postDeployMs, 95),
          first_10s_after_deploy_max_ms: postDeployMs.length ? Math.max(...postDeployMs) : -1,
        },
      });

      // ---- 503 and retries ----
      let attempts = 0;
      const counting: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input instanceof Request ? input.url : input).includes("/functions/v1/")) attempts++;
        return fetch(input, init);
      }) as typeof fetch;
      const sb = createClient(`https://${ctx.apiHost}`, keys.publishable, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: counting } });
      const cases: { id: string; query: string }[] = [
        { id: "503", query: "fail=503" },
        { id: "503-retry-after", query: "fail=503&retry_after=1" },
        { id: "502", query: "fail=502" },
        { id: "500", query: "fail=500" },
        { id: "429", query: "fail=429" },
        { id: "200", query: "" },
      ];
      for (const cs of cases) {
        const trials: { attempts: number; seen: string; status: number; cls: string; ms: number; hit: string }[] = [];
        for (let i = 0; i < 3; i++) {
          attempts = 0;
          const probeId = crypto.randomUUID();
          const t0 = performance.now();
          const r = await sb.functions.invoke(`${SLUG}${cs.query ? `?${cs.query}` : ""}`, { method: "GET", headers: { "x-probe-id": probeId } });
          const ms = Math.round(performance.now() - t0);
          let status = 200;
          let hit = "-";
          let cls = "none";
          if (r.error) {
            cls = r.error.constructor.name;
            const resp = (r.error as unknown as { context?: Response }).context;
            if (r.error instanceof FunctionsHttpError || r.error instanceof FunctionsRelayError) {
              status = resp?.status ?? 0;
              hit = resp?.headers.get("x-er-hit-status") ?? "-";
            } else status = 0;
          }
          const rows = cs.query ? (await sql(ctx, `select count(*)::int as n from public.er_hits where probe = '${probeId}'`)).rows[0]?.n : "-";
          trials.push({ attempts, seen: String(rows ?? "?"), status, cls, ms, hit });
        }
        const all1 = trials.every((t) => t.attempts === 1 && (t.seen === "1" || t.seen === "-"));
        out.push({
          id: `ER02-retry-${cs.id}`,
          title: `ER02 functions.invoke against an injected ${cs.id === "200" ? "200 (control)" : cs.id.replace("-", " ")}`,
          status: "info",
          detail: `3 trials: client attempts per invoke ${trials.map((t) => t.attempts).join("/")}, rows the function recorded for the request id ${trials.map((t) => t.seen).join("/")}, error class ${trials[0]?.cls}, HTTP ${trials[0]?.status}`,
          measurements: {
            trials: trials.length,
            client_attempts_each: trials.map((t) => t.attempts).join("/"),
            function_recorded_rows_each: trials.map((t) => t.seen).join("/"),
            function_insert_status_each: trials.map((t) => t.hit).join("/"),
            error_class: trials[0]?.cls ?? "",
            http_status: trials[0]?.status ?? 0,
            retried: all1 ? "no" : "yes",
            elapsed_ms_each: trials.map((t) => t.ms).join("/"),
          },
        });
      }

      // ---- latency window: function and RPC twin, interleaved ----
      const efPts: { t: number; ms: number }[] = [];
      const rpcPts: { t: number; ms: number }[] = [];
      const statuses = new Map<string, number>();
      const isolates = new Set<string>();
      let coldish = 0;
      const coldMs: number[] = [];
      const warmMs: number[] = [];
      let reused = 0;
      const seq: string[] = [];
      const wStart = Date.now();
      const rpcUrl = `https://${ctx.apiHost}/rest/v1/rpc/er_canary`;
      let tick = 0;
      while (Date.now() - wStart < WINDOW_S * 1000) {
        const slot = wStart + tick * 1000;
        tick++;
        const tEf = Date.now() - wStart;
        const s = performance.now();
        const res = await fetch(url, { headers: hdr, signal: AbortSignal.timeout(20_000) }).catch(() => null);
        const body = res ? ((await res.json().catch(() => ({}))) as { isolate?: string; age_ms?: number; served?: number }) : {};
        const ms = Math.round(performance.now() - s);
        const key = String(res?.status ?? 0);
        statuses.set(`ef_${key}`, (statuses.get(`ef_${key}`) ?? 0) + 1);
        if (body.isolate) isolates.add(body.isolate);
        if (typeof body.age_ms === "number" && body.age_ms < 2_000) {
          coldish++;
          coldMs.push(ms);
        } else if (typeof body.age_ms === "number") warmMs.push(ms);
        if (typeof body.served === "number" && body.served > 1) reused++;
        if (seq.length < 60) seq.push(`${(body.isolate ?? "-").slice(0, 4)}/age${body.age_ms ?? "-"}/n${body.served ?? "-"}/${ms}ms`);
        efPts.push({ t: tEf, ms });
        await sleep(500);
        const tRpc = Date.now() - wStart;
        const s2 = performance.now();
        const r2 = await fetch(rpcUrl, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) }).catch(() => null);
        await r2?.text().catch(() => "");
        rpcPts.push({ t: tRpc, ms: Math.round(performance.now() - s2) });
        const k2 = String(r2?.status ?? 0);
        statuses.set(`rpc_${k2}`, (statuses.get(`rpc_${k2}`) ?? 0) + 1);
        await sleep(Math.max(0, slot + 1000 - Date.now()));
      }
      const efMs = efPts.map((p) => p.ms);
      const rpcMs = rpcPts.map((p) => p.ms);
      const efBuckets = bucketP95(efPts, 30_000, (v) => percentile(v, 95)).filter((b) => b.n >= 10);
      const bucketP95s = efBuckets.map((b) => b.p95);
      const baseline = percentile(bucketP95s, 50);
      const fired = efBuckets.filter((b) => b.p95 > 2 * baseline).length;
      out.push({
        id: "ER02-lat",
        title: `ER02 latency over a ${WINDOW_S}s window: Edge Function vs RPC twin`,
        status: "info",
        detail: `function p50/p95/p99/max ${percentile(efMs, 50)}/${percentile(efMs, 95)}/${percentile(efMs, 99)}/${Math.max(...efMs)} ms over ${efMs.length} requests; RPC p50/p95 ${percentile(rpcMs, 50)}/${percentile(rpcMs, 95)} ms over ${rpcMs.length}`,
        measurements: {
          window_s: WINDOW_S,
          ef_n: efMs.length,
          ef_p50_ms: percentile(efMs, 50),
          ef_p95_ms: percentile(efMs, 95),
          ef_p99_ms: percentile(efMs, 99),
          ef_max_ms: Math.max(...efMs),
          rpc_n: rpcMs.length,
          rpc_p50_ms: percentile(rpcMs, 50),
          rpc_p95_ms: percentile(rpcMs, 95),
          rpc_p99_ms: percentile(rpcMs, 99),
          rpc_max_ms: Math.max(...rpcMs),
          ef_isolates_seen: isolates.size,
          ef_answers_from_isolate_under_2s_old: coldish,
          ef_answers_from_reused_isolate: reused,
          ef_young_isolate_p50_ms: percentile(coldMs, 50),
          ef_young_isolate_p95_ms: percentile(coldMs, 95),
          ef_older_isolate_n: warmMs.length,
          ef_older_isolate_p50_ms: percentile(warmMs, 50),
          ef_older_isolate_p95_ms: percentile(warmMs, 95),
          ef_bucket_30s_count: efBuckets.length,
          ef_bucket_p95_median_ms: baseline,
          ef_bucket_p95_max_ms: bucketP95s.length ? Math.max(...bucketP95s) : -1,
          ef_buckets_over_2x_median_p95: fired,
          statuses: [...statuses.entries()].sort().map(([k, v]) => `${k}=${v}`).join(" "),
        },
        evidence: `first ${seq.length} function answers as isolate-prefix/age_ms/served/latency: ${seq.join(" ")}`,
      });
    } catch (e) {
      out.push({ id: "ER02", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const st = ref ? await deleteProject(base, ref) : 0;
      out.push({ id: "ER02z", title: `ER02 cleanup: project (${PREFIX}er02-*)`, status: "info", detail: `project delete ${st}` });
    }
    return out;
  },
};

export default mod;
