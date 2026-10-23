/**
 * S23 - pg_cron, database webhooks and pg_net under restrict-all.
 *
 * Network restrictions gate inbound connections to the DB socket (S02/S10).
 * L22 (iap-lockdown) measured one Edge Function losing its direct socket under
 * restrict-all. Open: the work Postgres starts ITSELF - a pg_cron job, a
 * database webhook (the supabase_functions.http_request trigger, which queues
 * a pg_net request), and a bare pg_net call. Do they keep running while every
 * client address is excluded, and do the outbound requests leave?
 *
 * One fresh Pro-org Micro, created and deleted here. Inside it:
 *   - cron `s23-tick` every 2 s inserts a timestamp row;
 *   - cron `s23-fire` every 10 s calls public.s23_fire('cron'), which inserts
 *     an s23_events row (firing two webhook triggers: one to an Edge Function
 *     on the same project, one to a lab Cloudflare Worker) and makes two direct
 *     net.http_post calls to the same two receivers;
 *   - the orchestrator also inserts an s23_events row through the Data API in
 *     each phase (the app-write path that fires a webhook).
 * Receivers echo the nonce they read from the body, so the response pg_net
 * stores in net._http_response is the receipt; the Edge Function also writes
 * a receipt row through /rest/v1 with the service-role key.
 *
 * Phases on the DB clock: pre (open), enforced (restrict-all applied AND the
 * pooler refusing this machine - the control that the restriction is live),
 * post (restored and the pooler accepting again).
 *
 * Needs PVLAB_ORG_PRO and PVLAB_ENDPOINT_ECHO_WORKER (the Worker in
 * ../echo-worker, `make echo-worker-up`). DESTRUCTIVE: creates and deletes a
 * project.
 */
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { createProject, deleteProject, type Project, sleep } from "../lib/project.js";

const RESTRICT = { dbAllowedCidrs: ["192.0.2.0/24"], dbAllowedCidrsV6: ["2001:db8::/32"] };
const OPEN = { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] };
const EF = "s23-receiver";
const PRE_S = 45;
const ENFORCED_S = 120;
const POST_S = 45;

const EF_BODY = `
Deno.serve(async (req) => {
  const raw = await req.text();
  let body = {};
  try { body = JSON.parse(raw); } catch { /* not JSON */ }
  const record = body.record ?? {};
  const nonce = String(body.nonce ?? record.note ?? "");
  const out = { received: true, receiver: "edge-function", nonce, method: req.method, ua: req.headers.get("user-agent") ?? "", webhook_type: body.type ?? null, at: new Date().toISOString() };
  let stored = 0;
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const r = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/s23_receipts", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ nonce, ua: out.ua, webhook_type: out.webhook_type }),
    });
    stored = r.status;
  } catch { stored = -1; }
  return Response.json({ ...out, stored });
});
`;

const setupSql = (efUrl: string, workerUrl: string) => `
create extension if not exists pg_cron;
create extension if not exists pg_net;
create table public.s23_tick (id bigint generated always as identity primary key, ts timestamptz not null default clock_timestamp());
create table public.s23_events (id bigint generated always as identity primary key, note text not null, ts timestamptz not null default clock_timestamp());
create table public.s23_calls (id bigint generated always as identity primary key, kind text not null, nonce text not null, req_id bigint, ts timestamptz not null default clock_timestamp());
create table public.s23_receipts (id bigint generated always as identity primary key, nonce text, ua text, webhook_type text, ts timestamptz not null default clock_timestamp());
alter table public.s23_tick enable row level security;
alter table public.s23_events enable row level security;
alter table public.s23_calls enable row level security;
alter table public.s23_receipts enable row level security;
create or replace function public.s23_fire(src text) returns text
language plpgsql security definer set search_path = public, extensions as $fn$
declare n text := src || '-' || to_char(clock_timestamp(), 'HH24MISS.MS');
begin
  insert into public.s23_events(note) values (n);
  insert into public.s23_calls(kind, nonce, req_id) values
    ('direct-ef', n, net.http_post(url := '${efUrl}', body := jsonb_build_object('nonce', n), headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 5000)),
    ('direct-worker', n, net.http_post(url := '${workerUrl}', body := jsonb_build_object('nonce', n), headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 5000));
  return n;
end $fn$;
revoke execute on function public.s23_fire(text) from public, anon, authenticated;
grant execute on function public.s23_fire(text) to service_role;
create trigger s23_hook_ef after insert on public.s23_events for each row
  execute function supabase_functions.http_request('${efUrl}', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');
create trigger s23_hook_worker after insert on public.s23_events for each row
  execute function supabase_functions.http_request('${workerUrl}', 'POST', '{"Content-Type":"application/json"}', '{}', '5000');
notify pgrst, 'reload schema';
`;

type Row = Record<string, unknown>;

async function q(ctx: Ctx, ref: string, query: string): Promise<{ status: number; rows: Row[]; err: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 60_000);
  if (r.status < 300) return { status: r.status, rows: (Array.isArray(r.json) ? r.json : []) as Row[], err: "" };
  return { status: r.status, rows: [], err: String((r.json as { message?: string } | undefined)?.message ?? r.text).slice(0, 300) };
}
async function qOk(ctx: Ctx, ref: string, query: string): Promise<Row[]> {
  const r = await q(ctx, ref, query);
  if (r.status >= 300) throw new Error(`SQL ${r.status}: ${r.err}`);
  return r.rows;
}

/** One session-pooler connect from this machine: the control that tells whether restrict-all is live. */
async function poolerConnect(p: Project): Promise<{ ok: boolean; err: string }> {
  const c = new Client({ host: p.poolerHost, port: 5432, user: p.poolerUser, password: p.dbPass, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
  try {
    await c.connect();
    await c.query("select 1");
    return { ok: true, err: "" };
  } catch (e) {
    // Supavisor's refusal names the caller's address as {a, b, c, d}; drop it.
    return { ok: false, err: (e instanceof Error ? e.message : String(e)).replace(/\{[\d, ]+\}/g, "{<addr>}").slice(0, 200) };
  } finally {
    await c.end().catch(() => {});
  }
}

async function waitPooler(p: Project, want: boolean, timeoutMs: number): Promise<{ ok: boolean; s: number; err: string }> {
  const t0 = Date.now();
  let last = { ok: !want, err: "" };
  while (Date.now() - t0 < timeoutMs) {
    last = await poolerConnect(p);
    if (last.ok === want) return { ok: true, s: Math.round((Date.now() - t0) / 1000), err: last.err };
    await sleep(5_000);
  }
  return { ok: false, s: Math.round((Date.now() - t0) / 1000), err: last.err };
}

async function restInsertEvent(p: Project, note: string): Promise<number> {
  try {
    const r = await fetch(`https://${p.host}/rest/v1/s23_events`, {
      method: "POST",
      headers: { apikey: p.service, Authorization: `Bearer ${p.service}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ note }),
      signal: AbortSignal.timeout(20_000),
    });
    return r.status;
  } catch {
    return 0;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

const mod: TestModule = {
  id: "S23",
  title: "pg_cron, database webhooks and pg_net keep working under restrict-all",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "S23", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set: no Pro org to create the project in" }];
    const workerUrl = ctx.endpoints.echo_worker ?? "";
    if (!workerUrl) return [{ id: "S23", title: this.title, status: "skip", detail: "PVLAB_ENDPOINT_ECHO_WORKER not set (make echo-worker-up)" }];
    const results: TestResult[] = [];
    let ref = "";
    let restricted = false;
    const scrub = (s: string) => {
      const t = s.split(workerUrl).join("<worker>");
      return ref ? t.split(ref).join("<ref>") : t;
    };
    try {
      const p = await createProject(ctx, "pvlab-sec-s23-", (r) => {
        ref = r;
        console.error(`[S23] created project ${r}`);
      });
      const efUrl = `https://${p.host}/functions/v1/${EF}`;

      // Webhooks: the dashboard toggle's API form; it creates supabase_functions.
      const wh = await mgmt(ctx, "POST", `/projects/${p.ref}/database/webhooks/enable`, undefined, 60_000);
      let fnReady = false;
      for (let i = 0; i < 12 && !fnReady; i++) {
        const r = await q(ctx, p.ref, "select to_regproc('supabase_functions.http_request') is not null as ok");
        fnReady = r.rows[0]?.ok === true;
        if (!fnReady) await sleep(5_000);
      }
      if (!fnReady) throw new Error(`supabase_functions.http_request absent after webhooks/enable (HTTP ${wh.status})`);

      const dep = await mgmt(ctx, "POST", `/projects/${p.ref}/functions`, { slug: EF, name: EF, verify_jwt: false, body: EF_BODY });
      if (dep.status >= 300) throw new Error(`deploy EF HTTP ${dep.status}: ${dep.text.slice(0, 160)}`);

      await qOk(ctx, p.ref, setupSql(efUrl, workerUrl));
      // EF reachable over HTTP before any phase starts.
      let efOk = false;
      for (let i = 0; i < 24 && !efOk; i++) {
        try {
          const r = await fetch(efUrl, { method: "POST", body: JSON.stringify({ nonce: "warmup" }), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000) });
          efOk = r.status === 200;
        } catch { /* retry */ }
        if (!efOk) await sleep(5_000);
      }
      if (!efOk) throw new Error("receiver Edge Function never answered 200");

      const ver = await qOk(ctx, p.ref, `select (select extversion from pg_extension where extname='pg_cron') as cron, (select extversion from pg_extension where extname='pg_net') as net,
        current_setting('cron.use_background_workers', true) as bgw, current_setting('cron.host', true) as cron_host,
        (select count(*) from cron.job) as jobs_before`);

      // DB clock offset, so local phase boundaries map onto row timestamps.
      const l0 = Date.now();
      const sk = await qOk(ctx, p.ref, "select (extract(epoch from clock_timestamp()) * 1000)::bigint as ms");
      const l1 = Date.now();
      const skewMs = Number(sk[0]?.ms) - Math.round((l0 + l1) / 2);
      const db = (localMs: number) => iso(localMs + skewMs);

      await qOk(ctx, p.ref, `select cron.schedule('s23-tick', '2 seconds', $c$insert into public.s23_tick default values$c$);
        select cron.schedule('s23-fire', '10 seconds', $c$select public.s23_fire('cron')$c$);`);
      const tPre = Date.now();
      const base = await poolerConnect(p);
      await sleep(PRE_S * 1000 / 2);
      const restPre = await restInsertEvent(p, `rest-pre-${Date.now()}`);
      await sleep(PRE_S * 1000 / 2);

      const tApply = Date.now();
      const apply = await mgmt(ctx, "POST", `/projects/${p.ref}/network-restrictions/apply`, RESTRICT);
      restricted = apply.status < 300;
      const locked = await waitPooler(p, false, 180_000);
      const tEnf = Date.now();
      const nr = await mgmt(ctx, "GET", `/projects/${p.ref}/network-restrictions`);
      const nrStatus = String((nr.json as { status?: string } | undefined)?.status ?? "");
      const nrCfg = JSON.stringify((nr.json as { config?: unknown } | undefined)?.config ?? {});

      // The query endpoint is not a client socket; record whether it still answers.
      const mq = await q(ctx, p.ref, "select count(*) as n from public.s23_tick");
      await sleep(ENFORCED_S * 1000 / 2);
      const restEnf = await restInsertEvent(p, `rest-enforced-${Date.now()}`);
      await sleep(ENFORCED_S * 1000 / 2);
      const tRestore = Date.now();
      const back = await mgmt(ctx, "POST", `/projects/${p.ref}/network-restrictions/apply`, OPEN);
      restricted = back.status >= 300;
      const reopened = await waitPooler(p, true, 180_000);
      const tPost = Date.now();
      await sleep(POST_S * 1000 / 2);
      const restPost = await restInsertEvent(p, `rest-post-${Date.now()}`);
      await sleep(POST_S * 1000 / 2);
      await qOk(ctx, p.ref, "select cron.unschedule('s23-tick'); select cron.unschedule('s23-fire');");
      const tEnd = Date.now();
      await sleep(15_000); // let the last pg_net responses land

      const W = {
        pre: [db(tPre), db(tApply)],
        apply_to_enforced: [db(tApply), db(tEnf)],
        enforced: [db(tEnf), db(tRestore)],
        restore_to_open: [db(tRestore), db(tPost)],
        post: [db(tPost), db(tEnd)],
      } as const;
      const phaseCase = (col: string) =>
        `case ${Object.entries(W).map(([k, [a, b]]) => `when ${col} >= '${a}' and ${col} < '${b}' then '${k}'`).join(" ")} else 'outside' end`;

      // (1) pg_cron ticks per phase, longest gap between ticks across the run.
      const ticks = await qOk(ctx, p.ref, `select ${phaseCase("ts")} as phase, count(*)::int as n,
          round(extract(epoch from max(ts) - min(ts)))::int as span_s from public.s23_tick group by 1 order by min(ts)`);
      const gap = await qOk(ctx, p.ref, `select round(max(d), 1) as max_gap_s from (select extract(epoch from ts - lag(ts) over (order by ts)) as d from public.s23_tick) x`);
      // By command, not by a join on cron.job: the jobs are unscheduled (deleted from cron.job) before this read.
      const runs = await qOk(ctx, p.ref, `select case when d.command like '%s23_tick%' then 's23-tick' else 's23-fire' end as jobname,
          ${phaseCase("d.start_time")} as phase, d.status, count(*)::int as n, min(d.return_message) as msg
          from cron.job_run_details d group by 1, 2, 3 order by 1, min(d.start_time)`);

      // (2) webhooks: supabase_functions.hooks -> net._http_response.
      const hooks = await qOk(ctx, p.ref, `select h.hook_name as path, ${phaseCase("h.created_at")} as phase, count(*)::int as n,
          count(*) filter (where r.status_code = 200)::int as s200, count(*) filter (where r.id is null)::int as no_response,
          count(*) filter (where r.timed_out)::int as timed_out, count(*) filter (where r.content like '%"received":true%')::int as echoed,
          string_agg(distinct coalesce(r.status_code::text, 'null'), ',') as statuses, min(r.error_msg) as err
          from supabase_functions.hooks h left join net._http_response r on r.id = h.request_id group by 1, 2 order by 1, min(h.created_at)`);
      // (3) pg_net direct.
      const direct = await qOk(ctx, p.ref, `select c.kind as path, ${phaseCase("c.ts")} as phase, count(*)::int as n,
          count(*) filter (where r.status_code = 200)::int as s200, count(*) filter (where r.id is null)::int as no_response,
          count(*) filter (where r.timed_out)::int as timed_out, count(*) filter (where position(c.nonce in r.content) > 0)::int as echoed,
          string_agg(distinct coalesce(r.status_code::text, 'null'), ',') as statuses, min(r.error_msg) as err
          from public.s23_calls c left join net._http_response r on r.id = c.req_id group by 1, 2 order by 1, min(c.ts)`);
      const receipts = await qOk(ctx, p.ref, `select ${phaseCase("ts")} as phase, count(*)::int as n, min(ua) as ua from public.s23_receipts where nonce <> 'warmup' group by 1 order by min(ts)`);
      const restRows = await qOk(ctx, p.ref, `select e.note, count(r.id)::int as echoed, string_agg(r.status_code::text, ',') as statuses
          from public.s23_events e left join net._http_response r on position(e.note in r.content) > 0
          where e.note like 'rest-%' group by e.note, e.ts order by e.ts`);
      const sample = await qOk(ctx, p.ref, `select h.hook_name, r.status_code, left(r.content, 260) as content from supabase_functions.hooks h join net._http_response r on r.id = h.request_id
          where h.created_at >= '${W.enforced[0]}' and h.created_at < '${W.enforced[1]}' order by h.created_at limit 2`);

      const get = (rows: Row[], phase: string, path?: string) => rows.find((r) => r.phase === phase && (path === undefined || r.path === path)) ?? {};
      const n = (r: Row, k: string) => Number(r[k] ?? 0);
      const enfS = Math.round((tRestore - tEnf) / 1000);

      results.push({
        id: "S23a",
        title: "setup: fresh Micro, pg_cron + pg_net + webhooks enabled, receivers answering",
        status: "pass",
        detail: `${p.pgVersion}; pg_cron ${ver[0]?.cron}, pg_net ${ver[0]?.net}; cron.use_background_workers=${ver[0]?.bgw}, cron.host=${ver[0]?.cron_host}; webhooks/enable HTTP ${wh.status}; EF deploy HTTP ${dep.status}; DB clock offset ${skewMs} ms vs orchestrator`,
        measurements: { create_s: p.createS, webhooks_enable_status: wh.status, db_clock_offset_ms: skewMs },
      });
      results.push({
        id: "S23b",
        title: "control: restrict-all applied and the pooler refuses this machine",
        status: base.ok && locked.ok && reopened.ok ? "pass" : "fail",
        detail: `baseline pooler connect ${base.ok ? "ok" : `FAILED ${base.err}`}; apply HTTP ${apply.status}; refused after ${locked.s} s (${locked.ok ? locked.err : "never refused"}); GET network-restrictions status=${nrStatus} config=${nrCfg}; enforced window held ${enfS} s; restore HTTP ${back.status}; pooler accepted again after ${reopened.s} s`,
        measurements: { apply_status: apply.status, refused_after_s: locked.s, enforced_window_s: enfS, reopened_after_s: reopened.s },
        evidence: scrub(locked.err),
      });
      results.push({
        id: "S23g",
        title: "Management API query endpoint under restrict-all",
        status: "info",
        detail: mq.status < 300 ? `POST /database/query answered ${mq.status} while the pooler refused this machine (s23_tick count ${mq.rows[0]?.n})` : `POST /database/query -> ${mq.status}: ${scrub(mq.err)}`,
        measurements: { mgmt_query_status_enforced: mq.status },
      });

      const tp = get(ticks, "pre");
      const te = get(ticks, "enforced");
      const tq = get(ticks, "post");
      const cronFailed = runs.filter((r) => r.status !== "succeeded");
      results.push({
        id: "S23c",
        title: "pg_cron keeps running under restrict-all",
        status: n(te, "n") > 0 && runs.length > 0 && cronFailed.length === 0 ? "pass" : "fail",
        detail: `s23-tick (every 2 s) rows: pre ${n(tp, "n")} in ${Math.round((tApply - tPre) / 1000)} s, enforced ${n(te, "n")} in ${enfS} s, post ${n(tq, "n")} in ${Math.round((tEnd - tPost) / 1000)} s; longest gap between consecutive rows over the whole run ${gap[0]?.max_gap_s} s. cron.job_run_details: ${runs.map((r) => `${r.jobname}/${r.phase}/${r.status}=${r.n}`).join(", ")}${cronFailed.length ? `; first failure: ${scrub(String(cronFailed[0]?.msg ?? ""))}` : ""}`,
        measurements: { ticks_pre: n(tp, "n"), ticks_enforced: n(te, "n"), ticks_post: n(tq, "n"), max_tick_gap_s: Number(gap[0]?.max_gap_s ?? -1), cron_runs_not_succeeded: cronFailed.reduce((a, r) => a + n(r, "n"), 0) },
        evidence: JSON.stringify({ ticks, runs }).slice(0, 3000),
      });

      const line = (rows: Row[], path: string) =>
        ["pre", "enforced", "post"].map((ph) => {
          const r = get(rows, ph, path);
          return `${ph} ${n(r, "s200")}/${n(r, "n")} 200, echoed ${n(r, "echoed")}, statuses [${r.statuses ?? ""}]${n(r, "no_response") ? `, ${n(r, "no_response")} no response row` : ""}${r.err ? `, err ${scrub(String(r.err))}` : ""}`;
        }).join("; ");
      const hE = get(hooks, "enforced", "s23_hook_ef");
      const hW = get(hooks, "enforced", "s23_hook_worker");
      results.push({
        id: "S23d",
        title: "database webhooks (supabase_functions.http_request) deliver under restrict-all",
        status: n(hE, "n") > 0 && n(hE, "echoed") === n(hE, "n") && n(hW, "n") > 0 && n(hW, "echoed") === n(hW, "n") ? "pass" : "fail",
        detail: `to own Edge Function: ${line(hooks, "s23_hook_ef")}. To external CF Worker: ${line(hooks, "s23_hook_worker")}. Data API inserts (app path): ${restRows.map((r) => `${String(r.note).split("-").slice(0, 2).join("-")} webhook responses echoing its nonce ${r.echoed} of 2 [${r.statuses ?? ""}]`).join(", ")} (REST insert HTTP pre ${restPre}, enforced ${restEnf}, post ${restPost}).`,
        measurements: {
          hook_ef_enforced_n: n(hE, "n"), hook_ef_enforced_200: n(hE, "s200"), hook_ef_enforced_echoed: n(hE, "echoed"),
          hook_worker_enforced_n: n(hW, "n"), hook_worker_enforced_200: n(hW, "s200"), hook_worker_enforced_echoed: n(hW, "echoed"),
          rest_insert_enforced_status: restEnf,
        },
        evidence: scrub(JSON.stringify({ hooks, restRows, sample })).slice(0, 3000),
      });

      const dE = get(direct, "enforced", "direct-ef");
      const dW = get(direct, "enforced", "direct-worker");
      const rE = get(receipts, "enforced");
      results.push({
        id: "S23e",
        title: "pg_net direct calls leave the database under restrict-all",
        status: n(dE, "n") > 0 && n(dE, "echoed") === n(dE, "n") && n(dW, "n") > 0 && n(dW, "echoed") === n(dW, "n") ? "pass" : "fail",
        detail: `net.http_post to own Edge Function: ${line(direct, "direct-ef")}. To external CF Worker: ${line(direct, "direct-worker")}. Edge Function receipt rows written via /rest/v1 during enforced: ${n(rE, "n")} (user-agent ${rE.ua ?? "?"}).`,
        measurements: {
          direct_ef_enforced_n: n(dE, "n"), direct_ef_enforced_200: n(dE, "s200"), direct_ef_enforced_echoed: n(dE, "echoed"),
          direct_worker_enforced_n: n(dW, "n"), direct_worker_enforced_200: n(dW, "s200"), direct_worker_enforced_echoed: n(dW, "echoed"),
          ef_receipts_enforced: n(rE, "n"),
        },
        evidence: scrub(JSON.stringify({ direct, receipts })).slice(0, 3000),
      });
    } catch (e) {
      results.push({ id: "S23err", title: "S23 aborted", status: "fail", detail: scrub(e instanceof Error ? e.message : String(e)) });
    } finally {
      if (ref) {
        if (restricted) await mgmt(ctx, "POST", `/projects/${ref}/network-restrictions/apply`, OPEN).catch(() => {});
        const d = await deleteProject(ctx, ref);
        console.error(`[S23] delete ${ref}: HTTP ${d.deleteStatus}, gone after ${d.goneS}s`);
        results.push({
          id: "S23z",
          title: "teardown: project deleted and gone from the listing",
          status: d.deleteStatus < 300 && d.goneS >= 0 ? "pass" : "fail",
          detail: `DELETE ${d.deleteStatus}; absent from GET /projects after ${d.goneS} s`,
          measurements: { delete_status: d.deleteStatus, gone_from_listing_s: d.goneS },
        });
      }
    }
    return results;
  },
};
export default mod;
