/**
 * H02 - Hyperdrive (direct connection) and the Data API share one
 * max_connections: what happens as the total approaches it?
 *
 * One throwaway Small project (Pro org), one probe Worker, two Hyperdrive
 * configs on db.<ref>.supabase.co:5432, each logging in as its own
 * non-superuser role so pg_stat_activity separates them:
 *
 *   config A  role hd_a, no --origin-connection-limit (Cloudflare default)
 *   config B  role hd_b, --origin-connection-limit 5 (the documented minimum)
 *
 * The Worker runs one `select pg_sleep(s)` per request through the chosen
 * binding (new pg Client per request); this Mac drives K concurrent requests
 * with fetch (oha would give statuses but not the error bodies). Data API
 * holds are dc_sleep_xl(s) RPCs with the service_role key
 * (data-api-capacity lib).
 *
 * The observer. The Management API query endpoint logs in as `postgres`, a
 * non-superuser, so it is refused at the limit like any other client (run 1,
 * 2026-10-23: `53300 remaining connection slots are reserved for roles with
 * the SUPERUSER attribute` from H02e on). pg_stat_activity is therefore read
 * through config B's already-open origin connections: the Worker's `op=snap`
 * calls public.h02_snap(), SECURITY DEFINER owned by postgres, executable by
 * hd_b only. A Management API `select 1` is still tried at each step and its
 * outcome recorded. Per Hyperdrive role the snapshot also records the age of
 * state_change and the distinct query texts (added after run 2, not yet run),
 * so a pool floor can be told from keepalive or health queries in H02f. `op=kill` (public.h02_kill(role)) resets a role's
 * backends between phases; that is a reset, recorded as such, not recovery.
 *
 *   H02a  idle: max_connections, superuser_reserved_connections,
 *         reserved_connections, the Management API's login role, superuser and
 *         reserved-connection roles, backends by role at idle and after one
 *         request per binding
 *   H02b  limit: 20 concurrent 10 s holds through config B; peak hd_b backends,
 *         latencies (waves mean queueing), error texts with their latencies;
 *         origin_connection_limit for A and B read back; a create with 1
 *   H02c  Data API first: 30 dc_sleep_xl(100) holds fill PostgREST's pool, then
 *         Hyperdrive A steps of 10, 30, 45, 60 concurrent 15 s holds; per step
 *         backends by role mid-step, the Management API probe, errors verbatim
 *   H02d  recovery 1: 90 s of Data API pings, Management API probes and
 *         backend counts after H02c; then reset (kill hd_a and authenticator
 *         backends) so H02e starts with PostgREST needing new connections
 *   H02e  reverse: 80 concurrent 60 s Hyperdrive A holds first, then 30
 *         dc_sleep_xl(5) and one dc_ping through the Data API; statuses,
 *         codes, messages, latencies
 *   H02f  recovery 2: every 15 s until hd_a backends are gone, the Management
 *         API answers and 3 Data API pings in a row answer, capped at
 *         PVLAB_H02_RECOVERY_S (default 900; Cloudflare documents a 10 minute
 *         idle connection timeout)
 *
 * Not settled here: Hyperdrive with caching on, configs pointed at the
 * Supavisor pooler, sizes other than Small, Workers in other locations than
 * the one serving this Mac's requests, one run per row.
 *
 * DESTRUCTIVE: creates the project, Worker and configs; deletes all three in
 * finally and records what the listings show afterwards. Wrangler auth: the
 * Global API Key trio (CLOUDFLARE_EMAIL, CLOUDFLARE_API_KEY,
 * CLOUDFLARE_ACCOUNT_ID); self-skips without it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { errText, fmtCounts, rpc, SETUP_SQL, sql } from "../../data-api-capacity/lib/dc.js";

const run = promisify(execFile);
const REGION = process.env.PVLAB_H02_REGION || "ap-southeast-1";
const RECOVERY_S = Number(process.env.PVLAB_H02_RECOVERY_S || 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : -1);
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in wrangler output
const ANSI = /\x1b\[[0-9;]*m/g;

async function wrangler(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout, stderr } = await run("wrangler", args, { env: process.env, timeout: 180_000, cwd });
    return `${stdout}\n${stderr}`;
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`${x.stdout ?? ""}\n${x.stderr ?? ""}\n${x.message ?? ""}`);
  }
}

const WORKER = `
import { Client } from "pg";

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const hd = u.searchParams.get("b") === "B" ? env.HD_B : env.HD_A;
    const op = u.searchParams.get("op") ?? "hold";
    const s = Math.max(0, Math.min(120, Number(u.searchParams.get("s") ?? "0") || 0));
    const t0 = Date.now();
    const client = new Client({ connectionString: hd.connectionString });
    let phase = "connect";
    try {
      await client.connect();
      phase = "query";
      if (op === "snap") {
        const r = await client.query("select public.h02_snap() as j");
        return Response.json({ ok: true, rows: r.rows[0].j, ms: Date.now() - t0 });
      }
      if (op === "kill") {
        const role = u.searchParams.get("role") ?? "";
        const r = await client.query("select public.h02_kill($1) as n", [role]);
        return Response.json({ ok: true, n: r.rows[0].n, ms: Date.now() - t0 });
      }
      const r = await client.query(s > 0 ? "select pg_sleep(" + s + ") is null as ok, current_user as u" : "select true as ok, current_user as u");
      return Response.json({ ok: true, user: r.rows[0].u, ms: Date.now() - t0 });
    } catch (e) {
      return Response.json({ ok: false, phase, error: String(e && e.message ? e.message : e), code: String((e && e.code) || ""), ms: Date.now() - t0 }, { status: 500 });
    } finally {
      await client.end().catch(() => {});
    }
  },
};
`;

const OBSERVER_SQL = `
create or replace function public.h02_snap() returns json language sql security definer set search_path = pg_catalog as $$
  select coalesce(json_agg(t), '[]'::json) from (
    select coalesce(usename, '') as u, coalesce(application_name, '') as app, backend_type as bt,
           count(*)::int as n, count(*) filter (where wait_event = 'PgSleep')::int as sleeping,
           count(*) filter (where state = 'idle')::int as idle, count(distinct client_addr)::int as addrs,
           coalesce(min(extract(epoch from now() - state_change))::int, -1) as since_change_min_s,
           coalesce(max(extract(epoch from now() - state_change))::int, -1) as since_change_max_s,
           coalesce(string_agg(distinct left(regexp_replace(query, '\\s+', ' ', 'g'), 60), ' || ')
             filter (where usename in ('hd_a', 'hd_b')), '') as queries
      from pg_stat_activity group by 1, 2, 3 order by 4 desc, 1) t $$;
create or replace function public.h02_kill(r text) returns int language sql security definer set search_path = pg_catalog as $$
  select count(pg_terminate_backend(pid))::int from pg_stat_activity where usename = r and pid <> pg_backend_pid() $$;
revoke all on function public.h02_snap(), public.h02_kill(text) from public, anon, authenticated, service_role;
grant execute on function public.h02_snap(), public.h02_kill(text) to hd_b;`;

interface Hold {
  status: number;
  ms: number;
  ok: boolean;
  phase: string;
  error: string;
  code: string;
}

/** Summary of a set of request outcomes; error texts verbatim with counts and their latency range. */
function summarise(xs: Hold[]): Record<string, string | number> {
  const okMs = xs.filter((x) => x.ok).map((x) => x.ms);
  const errs = xs.filter((x) => !x.ok);
  const byErr: Record<string, number[]> = {};
  for (const e of errs) {
    const k = `${e.status}${e.code ? `/${e.code}` : ""}${e.phase ? `/${e.phase}` : ""}: ${e.error}`.slice(0, 200);
    (byErr[k] ??= []).push(e.ms);
  }
  const byStatus: Record<string, number> = {};
  for (const x of xs) byStatus[String(x.status)] = (byStatus[String(x.status)] ?? 0) + 1;
  return {
    n: xs.length,
    ok: okMs.length,
    statuses: fmtCounts(byStatus),
    ok_ms_min: okMs.length ? Math.min(...okMs) : -1,
    ok_ms_med: median(okMs),
    ok_ms_max: okMs.length ? Math.max(...okMs) : -1,
    errors: Object.entries(byErr).map(([k, ms]) => `${ms.length}x [${Math.min(...ms)}-${Math.max(...ms)} ms] ${k}`).join(" | ") || "none",
  };
}

const mod: TestModule = {
  id: "H02",
  title: "Hyperdrive and the Data API on one max_connections: origin connections, first failure, usable slots, recovery",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ORG = ctx.orgs.pro ?? "";
    const skip = (detail: string): TestResult[] => [{ id: "H02", title: this.title, status: "skip", detail }];
    if (!ORG) return skip("PVLAB_ORG_PRO not set");
    for (const v of ["CLOUDFLARE_EMAIL", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (!process.env[v]) return skip(`${v} not set (wrangler Global API Key trio)`);
    }

    let ref = "";
    const configIds: string[] = [];
    const workerName = `h02-probe-${Date.now().toString(36)}`;
    let workdir = "";
    let deployed = false;
    const meas: Record<string, number | string> = {};
    const ev: string[] = [];
    const red = (s: string) =>
      (ref ? s.replaceAll(ref, "<ref>") : s)
        .replace(ANSI, "")
        .replace(/postgres(ql)?:\/\/[^\s"]+/g, "<conn>")
        .replace(/accounts\/[0-9a-f]{32}/g, "accounts/<account>")
        .replace(/\s+/g, " ");
    const note = (k: string, v: string) => ev.push(`${k}: ${red(v)}`);
    const t0Run = Date.now();
    const at = () => Math.round((Date.now() - t0Run) / 1000);

    let base = "";
    const hd = async (b: "A" | "B", s: number, extra = ""): Promise<Hold & { body: Record<string, unknown> }> => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${base}/?b=${b}&s=${s}${extra}`, { signal: AbortSignal.timeout((s + 150) * 1000), keepalive: false });
        const text = await res.text();
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 160) }; }
        return { status: res.status, ms: Math.round(performance.now() - t0), ok: j.ok === true, phase: String(j.phase ?? ""), error: red(String(j.error ?? "")), code: String(j.code ?? ""), body: j };
      } catch (e) {
        return { status: 0, ms: Math.round(performance.now() - t0), ok: false, phase: "client", error: errText(e), code: "", body: {} };
      }
    };

    // Snapshot: through config B's open connections (works at the limit), plus a
    // Management API `select 1` whose outcome is recorded.
    interface Snap { ok: boolean; clients: number; byRole: Record<string, number>; mgmt: string }
    const mgmtProbe = async (): Promise<string> => {
      const r = await sql(ctx, ref, "select 1 as one", 30_000);
      return r.rows ? "ok" : red(`${r.status} ${r.error ?? ""}`).slice(0, 200);
    };
    const snap = async (label: string, record = true): Promise<Snap> => {
      const [r, mg] = await Promise.all([hd("B", 0, "&op=snap"), mgmtProbe()]);
      if (record) meas[`${label}_mgmt_api`] = mg;
      if (!r.ok) {
        if (record) meas[`${label}_snapshot`] = `failed: ${r.status} ${r.code} ${r.error}`.slice(0, 250);
        note(`${label} t+${at()}s`, `snapshot failed: ${r.status} ${r.code} ${r.error}; mgmt ${mg}`);
        return { ok: false, clients: -1, byRole: {}, mgmt: mg };
      }
      const rows = (Array.isArray(r.body.rows) ? r.body.rows : []) as {
        u: string; app: string; bt: string; n: number; sleeping: number; idle: number; addrs: number;
        since_change_min_s: number; since_change_max_s: number; queries: string;
      }[];
      const byRole: Record<string, number> = {};
      let clients = 0;
      const parts: string[] = [];
      for (const row of rows) {
        if (row.bt === "client backend") {
          clients += row.n;
          byRole[row.u] = (byRole[row.u] ?? 0) + row.n;
        }
        // state_change age and last query text separate a pool floor from
        // keepalive or health queries (H02f run 2 could not: state only).
        const extra = row.u === "hd_a" || row.u === "hd_b" ? `, state_change ${row.since_change_min_s}-${row.since_change_max_s} s ago, queries [${row.queries}]` : "";
        parts.push(`${row.u || "-"}/${row.app || "-"}/${row.bt}:${row.n}(sleep ${row.sleeping}, idle ${row.idle}, addrs ${row.addrs}${extra})`);
      }
      if (record) {
        meas[`${label}_client_backends`] = clients;
        meas[`${label}_by_role`] = fmtCounts(byRole);
      }
      note(`${label} t+${at()}s`, `${parts.join("; ")}; mgmt ${mg}`);
      return { ok: true, clients, byRole, mgmt: mg };
    };

    let keys = { anon: "", service: "" };
    let host = "";
    const dapi = async (fn: string, args: unknown, timeoutMs: number): Promise<Hold> => {
      const r = await rpc(host, fn, args, keys.service, keys.service, timeoutMs);
      return { status: r.status, ms: r.ms, ok: r.status === 200, phase: "", error: red(r.status === 200 ? "" : (r.message || r.body)), code: r.code };
    };
    const put = (prefix: string, o: Record<string, string | number>) => {
      for (const [k, v] of Object.entries(o)) meas[`${prefix}_${k}`] = v;
    };

    try {
      // ---- provision -------------------------------------------------------
      const dbPass = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
      const tCreate = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `pvlab-h02-${Date.now()}`,
        db_pass: dbPass,
        region: REGION,
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (create.status !== 201 || !ref) throw new Error(`create project: HTTP ${create.status} ${create.text.slice(0, 200)}`);
      host = `${ref}.supabase.co`;
      let status = "";
      for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
        status = String((p?.json as { status?: string } | undefined)?.status ?? "");
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);
      let version = "";
      for (let i = 0; i < 24 && !version; i++) {
        const r = await sql(ctx, ref, "select version() as v");
        version = String(r.rows?.[0]?.v ?? "");
        if (!version) await sleep(5_000);
      }
      if (!version) throw new Error("database never answered the management query");
      meas.region = REGION;
      meas.postgres_version = version.split(" on ")[0] ?? version;
      meas.project_ready_s = Math.round((Date.now() - tCreate) / 1000);

      const setup = await sql(ctx, ref, SETUP_SQL);
      if (setup.error) throw new Error(`setup sql: ${setup.error}`);
      const pw = { A: `${crypto.randomUUID().replaceAll("-", "")}Aa1`, B: `${crypto.randomUUID().replaceAll("-", "")}Bb1` };
      const roles = await sql(ctx, ref, `create role hd_a login password '${pw.A}'; create role hd_b login password '${pw.B}';`);
      if (roles.error) throw new Error(`create roles: ${roles.error}`);
      const obs = await sql(ctx, ref, OBSERVER_SQL);
      if (obs.error) throw new Error(`observer functions: ${obs.error}`);

      const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const rows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
      keys = { anon: rows.find((x) => x.name === "anon")?.api_key ?? "", service: rows.find((x) => x.name === "service_role")?.api_key ?? "" };
      if (!keys.anon || !keys.service) throw new Error("legacy anon/service_role keys absent");
      for (let i = 0; i < 30; i++) {
        if ((await rpc(host, "dc_ping", {}, keys.anon, keys.anon)).status === 200) break;
        await sleep(2_000);
      }

      // ---- H02a settings and idle -----------------------------------------
      const settings = await sql(ctx, ref, `select current_setting('max_connections')::int as max_connections,
          current_setting('superuser_reserved_connections')::int as su_reserved,
          coalesce(current_setting('reserved_connections', true), 'absent') as reserved,
          current_user as mgmt_current_user, session_user as mgmt_session_user,
          (select rolsuper from pg_roles where rolname = session_user) as mgmt_session_super,
          (select string_agg(rolname, ',' order by rolname) from pg_roles where rolsuper) as superusers,
          (select coalesce(string_agg(r.rolname, ',' order by r.rolname), '') from pg_roles r
             where r.rolname not like 'pg\\_%' and pg_has_role(r.oid, 'pg_use_reserved_connections', 'member')) as reserved_members,
          (select string_agg(rolname || '=' || rolconnlimit, ',' order by rolname) from pg_roles where rolconnlimit <> -1) as role_conn_limits,
          (select rolsuper::text || '/' || rolcreaterole::text from pg_roles where rolname = 'postgres') as postgres_super_createrole,
          pg_has_role('postgres', 'pg_signal_backend', 'member') as postgres_signal_backend,
          current_setting('max_worker_processes')::int as max_worker_processes`);
      const s0 = settings.rows?.[0] ?? {};
      for (const [k2, v] of Object.entries(s0)) meas[`a_${k2}`] = String(v ?? "null");

      workdir = await mkdtemp(join(tmpdir(), "h02-"));
      const dbHost = `db.${ref}.supabase.co`;
      const mk = async (name: string, user: string, pass: string, extra: string[]): Promise<{ id: string; err: string }> => {
        const conn = `postgresql://${user}:${encodeURIComponent(pass)}@${dbHost}:5432/postgres`;
        let err = "";
        for (let i = 0; i < 6; i++) {
          try {
            const out = await wrangler(["hyperdrive", "create", name, "--connection-string", conn, "--caching-disabled", ...extra], workdir);
            const id = out.match(/[0-9a-f]{32}/)?.[0] ?? "";
            if (id) {
              configIds.push(id);
              return { id, err: "" };
            }
            err = red(out).slice(0, 400);
          } catch (e) {
            const full = red(e instanceof Error ? e.message : String(e));
            err = (full.slice(full.indexOf("ERROR") >= 0 ? full.indexOf("ERROR") : 0)).slice(0, 400);
            // A refused flag value is not worth retrying (run 1: the limit-1 create).
            if (/origin.connection.limit|origin_connection_limit|max_size|Invalid conn/i.test(err)) return { id: "", err };
          }
          await sleep(15_000);
        }
        return { id: "", err };
      };
      const readLimit = async (id: string): Promise<string> => {
        try {
          const out = await wrangler(["hyperdrive", "get", id], workdir);
          const m = out.match(/"origin_connection_limit"\s*:\s*([^,\n}]+)/);
          return m ? m[1]!.trim() : "absent from get output";
        } catch (e) {
          return `get failed: ${red(errText(e))}`;
        }
      };

      // Lower bound of the flag: try 1 (documented minimum is 5), delete if saved.
      const one = await mk(`${workerName}-one`, "hd_b", pw.B, ["--origin-connection-limit", "1"]);
      meas.b_limit_1_create = one.id ? `saved (read back ${await readLimit(one.id)})` : `refused: ${one.err}`;
      if (one.id) {
        await wrangler(["hyperdrive", "delete", one.id], workdir).catch(() => "");
        configIds.splice(configIds.indexOf(one.id), 1);
      }
      const A = await mk(`${workerName}-a`, "hd_a", pw.A, []);
      if (!A.id) throw new Error(`hyperdrive create A: ${A.err}`);
      const B = await mk(`${workerName}-b`, "hd_b", pw.B, ["--origin-connection-limit", "5"]);
      if (!B.id) throw new Error(`hyperdrive create B: ${B.err}`);
      meas.b_config_a_origin_connection_limit = await readLimit(A.id);
      meas.b_config_b_origin_connection_limit = await readLimit(B.id);

      await writeFile(join(workdir, "worker.js"), WORKER);
      await writeFile(join(workdir, "wrangler.jsonc"), JSON.stringify({
        name: workerName,
        main: "worker.js",
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        hyperdrive: [{ binding: "HD_A", id: A.id }, { binding: "HD_B", id: B.id }],
      }, null, 2));
      await run("bun", ["add", "pg@^8.16.3"], { cwd: workdir, timeout: 90_000 });
      meas.pg_driver_version = await run("bun", ["pm", "ls"], { cwd: workdir }).then((r) => r.stdout.match(/pg@([\d.]+)/)?.[1] ?? "?").catch(() => "?");
      const deployOut = await wrangler(["deploy", "--config", "wrangler.jsonc"], workdir);
      deployed = true;
      base = deployOut.match(/https:\/\/[^\s/]+\.workers\.dev/)?.[0] ?? "";
      if (!base) throw new Error(`no workers.dev URL in deploy output: ${red(deployOut).slice(0, 300)}`);
      // Run 1 got 404 HTML from workers.dev on 9 requests after a first good
      // answer (deploy propagation): wait for 10 good answers in a row, in
      // parallel bursts of 5, per binding.
      for (const b of ["A", "B"] as const) {
        let good = 0;
        let tries = 0;
        let last = "";
        while (good < 10 && tries < 60) {
          const rs = await Promise.all(Array.from({ length: 5 }, () => hd(b, 0)));
          tries++;
          for (const r of rs) good = r.ok ? good + 1 : 0;
          last = rs.find((r) => !r.ok)?.error.slice(0, 80) ?? last;
          if (good < 10) await sleep(3_000);
        }
        meas[`a_warmup_${b}`] = good >= 10 ? `ok after ${tries} bursts` : `not stable: ${last}`;
        if (good < 10) throw new Error(`binding ${b} not stable after warm-up: ${last}`);
      }
      // Idle after the warm-up; then let config B hold its connections for the observer.
      await sleep(3_000);
      await snap("a_after_warmup");

      // ---- H02b origin_connection_limit 5 ---------------------------------
      {
        const p = Promise.all(Array.from({ length: 20 }, () => hd("B", 10)));
        // The observer needs a free B connection, so read through the
        // Management API here (nowhere near the limit in this phase).
        const mgSnap = async (label: string) => {
          const r = await sql(ctx, ref, "select count(*) filter (where usename = 'hd_b')::int as hd_b, count(*) filter (where usename = 'hd_b' and wait_event = 'PgSleep')::int as sleeping from pg_stat_activity", 30_000);
          meas[`${label}_hd_b`] = r.rows ? `${r.rows[0]?.hd_b} (sleeping ${r.rows[0]?.sleeping})` : `failed: ${r.error}`;
          return Number(r.rows?.[0]?.hd_b ?? -1);
        };
        await sleep(5_000);
        const m1 = await mgSnap("b_mid5s");
        await sleep(10_000);
        const m2 = await mgSnap("b_mid15s");
        await sleep(10_000);
        const m3 = await mgSnap("b_mid25s");
        const rs = await p;
        put("b_k20_s10", summarise(rs));
        meas.b_peak_hd_b = Math.max(m1, m2, m3);
      }
      await snap("b_after");

      // ---- H02c Data API first, Hyperdrive steps --------------------------
      {
        const dAll = Promise.all(Array.from({ length: 30 }, () => dapi("dc_sleep_xl", { s: 100 }, 200_000)));
        await sleep(8_000);
        await snap("c_dapi_held");
        for (const K of [10, 30, 45, 60]) {
          const p = Promise.all(Array.from({ length: K }, () => hd("A", 15)));
          await sleep(7_000);
          await snap(`c_step${K}`);
          const rs = await p;
          put(`c_step${K}`, summarise(rs));
          await sleep(1_000);
        }
        put("c_dapi_holders", summarise(await dAll));
      }

      // ---- H02d recovery 1, then reset -----------------------------------
      {
        const series: string[] = [];
        const tR = Date.now();
        while (Date.now() - tR < 90_000) {
          const [s, ping] = await Promise.all([snap("d_tmp", false), dapi("dc_ping", {}, 15_000)]);
          series.push(`t+${Math.round((Date.now() - tR) / 1000)}s hd_a=${s.byRole.hd_a ?? "?"} auth=${s.byRole.authenticator ?? "?"} clients=${s.clients} mgmt=${s.mgmt === "ok" ? "ok" : "refused"} ping=${ping.status}${ping.code ? `/${ping.code}` : ""}`);
          await sleep(10_000);
        }
        meas.d_series = series.join("; ");
        const kA = await hd("B", 0, "&op=kill&role=hd_a");
        const kP = await hd("B", 0, "&op=kill&role=authenticator");
        meas.d_reset_killed_hd_a = kA.ok ? Number(kA.body.n) : `failed: ${kA.error}`;
        meas.d_reset_killed_authenticator = kP.ok ? Number(kP.body.n) : `failed: ${kP.error}`;
        await sleep(5_000);
        let pings = 0;
        let okRun = 0;
        while (okRun < 3 && pings < 60) {
          const r = await dapi("dc_ping", {}, 15_000);
          pings++;
          okRun = r.ok ? okRun + 1 : 0;
          if (okRun < 3) await sleep(2_000);
        }
        meas.d_reset_pings_to_3_ok = pings;
        await snap("d_after_reset");
      }

      // ---- H02e reverse: Hyperdrive first, then the Data API --------------
      {
        const pH = Promise.all(Array.from({ length: 80 }, () => hd("A", 60)));
        await sleep(10_000);
        await snap("e_hd_held");
        const pD = Promise.all(Array.from({ length: 30 }, () => dapi("dc_sleep_xl", { s: 5 }, 150_000)));
        const pPing = dapi("dc_ping", {}, 150_000);
        await sleep(10_000);
        await snap("e_both");
        const [hs, ds, ping] = await Promise.all([pH, pD, pPing]);
        put("e_hd_k80_s60", summarise(hs));
        put("e_dapi_k30_s5", summarise(ds));
        meas.e_dapi_ping = `${ping.status}${ping.code ? `/${ping.code}` : ""} ${ping.ms} ms ${ping.error}`.slice(0, 250);
        await snap("e_after");
      }

      // ---- H02f recovery 2 -----------------------------------------------
      {
        const series: string[] = [];
        const tR = Date.now();
        let goneS = -1;
        let mgmtOkS = -1;
        let pingOkS = -1;
        let okRun = 0;
        while (Date.now() - tR < RECOVERY_S * 1000) {
          const [s, ping] = await Promise.all([snap("f_tmp", false), dapi("dc_ping", {}, 15_000)]);
          const t = Math.round((Date.now() - tR) / 1000);
          okRun = ping.ok ? okRun + 1 : 0;
          if (okRun >= 3 && pingOkS < 0) pingOkS = t;
          if (s.mgmt === "ok" && mgmtOkS < 0) mgmtOkS = t;
          if (s.ok && (s.byRole.hd_a ?? 0) === 0 && goneS < 0) goneS = t;
          series.push(`t+${t}s hd_a=${s.byRole.hd_a ?? "?"} auth=${s.byRole.authenticator ?? "?"} clients=${s.clients} mgmt=${s.mgmt === "ok" ? "ok" : "refused"} ping=${ping.status}${ping.code ? `/${ping.code}` : ""}`);
          if (goneS >= 0 && mgmtOkS >= 0 && pingOkS >= 0) break;
          await sleep(15_000);
        }
        meas.f_cap_s = RECOVERY_S;
        meas.f_hd_a_gone_s = goneS;
        meas.f_mgmt_first_ok_s = mgmtOkS;
        meas.f_ping_3_ok_s = pingOkS;
        meas.f_series = series.join("; ");
        await snap("f_end");
      }

      return [{
        id: "H02",
        title: this.title,
        status: "pass",
        detail: "measured; see measurements and evidence (the module records behaviour, it asserts none)",
        measurements: meas,
        evidence: ev.join("\n"),
      }];
    } catch (e) {
      return [{
        id: "H02",
        title: this.title,
        status: "fail",
        detail: `threw: ${red(e instanceof Error ? e.message : String(e)).slice(0, 400)}`,
        measurements: meas,
        evidence: ev.join("\n"),
      }];
    } finally {
      // Teardown, then read the listings back so "deleted" is an observation.
      if (deployed) meas.teardown_worker_delete = /deleted|success/i.test(await wrangler(["delete", "--name", workerName, "--force"], workdir).catch((e) => String(e))) ? "deleted" : "check";
      for (const id of configIds) await wrangler(["hyperdrive", "delete", id], workdir || ".").catch(() => "");
      if (configIds.length) {
        const list = await wrangler(["hyperdrive", "list"], workdir || ".").catch((e) => String(e));
        meas.teardown_hyperdrive_left = configIds.filter((id) => list.includes(id)).length;
      }
      if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => null);
      if (ref) {
        const del = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => undefined);
        meas.teardown_project_delete_status = del?.status ?? 0;
        let goneS = -1;
        const t0 = Date.now();
        while (Date.now() - t0 < 240_000) {
          const l = await mgmt(ctx, "GET", "/projects").catch(() => undefined);
          const arr = (Array.isArray(l?.json) ? l!.json : []) as { id?: string; ref?: string }[];
          if (l?.status === 200 && !arr.some((x) => (x.ref ?? x.id) === ref)) {
            goneS = Math.round((Date.now() - t0) / 1000);
            break;
          }
          await sleep(10_000);
        }
        meas.teardown_project_gone_s = goneS;
      }
    }
  },
};
export default mod;
