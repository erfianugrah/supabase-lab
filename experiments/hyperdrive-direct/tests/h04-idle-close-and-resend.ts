/**
 * H04 - follow-ups from H03 (2026-10-23), one Pro-org project, Small for Q1,
 * resized to Medium for Q2.
 *
 * Q1. Who closes Hyperdrive's idle origin connections, and when? H03 (one
 * run) saw them close between 965 and 1182-1265 s idle, with no sample in
 * the 217 s and 83 s gaps where the closes happened (the Mac slept through
 * both). This module:
 *   - turns on `log_connections` and `log_disconnections` through
 *     `PUT /config/database/postgres` before any Hyperdrive connection exists,
 *     so every origin connection's close is a `disconnection: session time`
 *     line with the backend's pid, and a server-side close would be a FATAL
 *     with its reason;
 *   - samples pg_stat_activity through the Management API on a fixed wall
 *     schedule (every PVLAB_H04_SAMPLE_S, 10 s) instead of sleeping after each
 *     sample, and records the largest gap between samples;
 *   - fills config A (no limit flag) with 40 concurrent 20 s holds and sends
 *     it nothing afterwards (the H03 Q1 repeat), and config T (no limit flag)
 *     with 20 holds and then one `select` every PVLAB_H04_TRICKLE_S (120 s)
 *     until PVLAB_H04_TRICKLE_UNTIL_S (1500 s): if one request resets the
 *     other connections' idle clock, T's untouched connections outlive A's;
 *   - leaves config B (limit 5, the Q2 observer) alone after its warm-up, so
 *     its connections are a third idle sample.
 * Per pid: last query end (sample wall time minus `state_change` age, the
 * latest seen), last seen, and the disconnection line's time and session time.
 *
 * Q2. What resends a request to PostgREST after a 503, on a size other than
 * Small?
 * Same arms as H03 Q2 on Medium, with every Data API answer's
 * `x-envoy-attempt-count` header kept and PostgREST access lines counted by
 * status and body size. Free slots are set by filling A (80 holds, 45 s) and
 * then T with as many 35 s holds as leave the arm's target of free slots
 * (6, 3, 0).
 *
 *   q2a  control: reset authenticator, no Hyperdrive load
 *   q2b  reset authenticator, A + T to 6 free
 *   q2c  warm pool (12 dc_sleep_xl(2)), no reset, A + T to 3 free
 *   q2d  reset authenticator, A + T to 0 free
 *
 * DESTRUCTIVE: creates the project, the Worker and three configs; deletes all
 * in finally and records what the listings show afterwards.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery } from "../../../harness/src/platform.js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { type DcProject, errText, fmtCounts, request, resize, SETUP_SQL, sql } from "../../data-api-capacity/lib/dc.js";
import { ANSI, type Hold, summarise, wrangler } from "./h02-connection-budget.js";

const run = promisify(execFile);
const REGION = process.env.PVLAB_H04_REGION || "ap-southeast-1";
const WATCH_S = Number(process.env.PVLAB_H04_WATCH_S || 2700);
const SAMPLE_S = Number(process.env.PVLAB_H04_SAMPLE_S || 10);
const TRICKLE_S = Number(process.env.PVLAB_H04_TRICKLE_S || 120);
const TRICKLE_UNTIL_S = Number(process.env.PVLAB_H04_TRICKLE_UNTIL_S || 1500);
const Q2_SIZE = process.env.PVLAB_H04_Q2_SIZE || "ci_medium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HD_ROLES = ["hd_a", "hd_b", "hd_t"];

const WORKER = `
import { Client } from "pg";

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const b = u.searchParams.get("b") ?? "A";
    const hd = env["HD_" + b] ?? env.HD_A;
    const op = u.searchParams.get("op") ?? "hold";
    const s = Math.max(0, Math.min(120, Number(u.searchParams.get("s") ?? "0") || 0));
    const t0 = Date.now();
    const client = new Client({ connectionString: hd.connectionString });
    let phase = "connect";
    try {
      await client.connect();
      phase = "query";
      if (op === "snap") {
        const roles = (u.searchParams.get("roles") ?? "").split(",").filter(Boolean);
        const r = await client.query("select public.h04_snap($1::text[]) as j", [roles]);
        return Response.json({ ok: true, snap: r.rows[0].j, ms: Date.now() - t0 });
      }
      if (op === "kill") {
        const r = await client.query("select public.h04_kill($1) as n", [u.searchParams.get("role") ?? ""]);
        return Response.json({ ok: true, n: r.rows[0].n, ms: Date.now() - t0 });
      }
      const r = await client.query(s > 0 ? "select pg_sleep(" + s + ") is null as ok, current_user as u, pg_backend_pid() as pid" : "select true as ok, current_user as u, pg_backend_pid() as pid");
      return Response.json({ ok: true, user: r.rows[0].u, pid: r.rows[0].pid, ms: Date.now() - t0 });
    } catch (e) {
      return Response.json({ ok: false, phase, error: String(e && e.message ? e.message : e), code: String((e && e.code) || ""), ms: Date.now() - t0 }, { status: 500 });
    } finally {
      await client.end().catch(() => {});
    }
  },
};
`;

const OBSERVER_SQL = `
create or replace function public.h04_snap(roles text[]) returns json language sql security definer set search_path = pg_catalog as $$
  select json_build_object(
    'max_conn', current_setting('max_connections')::int,
    'su_reserved', current_setting('superuser_reserved_connections')::int,
    'by_role', (select coalesce(json_agg(t), '[]'::json) from (
        select coalesce(usename, '') as u, count(*)::int as n,
               count(*) filter (where state = 'idle')::int as idle,
               count(*) filter (where state = 'active')::int as active
          from pg_stat_activity where backend_type = 'client backend' group by 1 order by 1) t),
    'rows', (select coalesce(json_agg(r), '[]'::json) from (
        select pid, usename as u, coalesce(state, '') as st, coalesce(wait_event, '') as we,
               coalesce(extract(epoch from now() - state_change)::int, -1) as sc,
               coalesce(extract(epoch from now() - backend_start)::int, -1) as bs,
               coalesce(left(regexp_replace(query, '\\s+', ' ', 'g'), 70), '') as q,
               coalesce(host(client_addr), '') as a
          from pg_stat_activity where usename = any(roles) and pid <> pg_backend_pid()) r)) $$;
create or replace function public.h04_kill(r text) returns int language sql security definer set search_path = pg_catalog as $$
  select count(pg_terminate_backend(pid))::int from pg_stat_activity where usename = r and pid <> pg_backend_pid() $$;
revoke all on function public.h04_snap(text[]), public.h04_kill(text) from public, anon, authenticated, service_role;
grant execute on function public.h04_snap(text[]), public.h04_kill(text) to hd_b;`;

interface Row { pid: number; u: string; st: string; we: string; sc: number; bs: number; q: string; a: string }
interface Snap {
  ok: boolean;
  err: string;
  limit: number;
  clients: number;
  byRole: Record<string, { n: number; idle: number; active: number }>;
  rows: Row[];
}
/** One origin backend as the Q1 watch saw it; times are wall ms. */
interface Life {
  role: string;
  a: string;
  firstSeen: number;
  lastSeen: number;
  /** Wall time the sample after `lastSeen` answered without this pid (-1: still there at the end). */
  goneBy: number;
  /** Latest end of a query on it: sample wall time minus state_change age. */
  lastQueryEnd: number;
  /** Distinct query ends seen after load end (a trickle request landing on it). */
  uses: number;
  stLast: string;
  q: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const range = (xs: number[]) => (xs.length ? `${Math.min(...xs)}-${Math.max(...xs)}` : "none");

const mod: TestModule = {
  id: "H04",
  title: "Hyperdrive idle origin connections: who closes them and when, with and without a trickle; the 503 resend in front of PostgREST on Medium",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ORG = ctx.orgs.pro ?? "";
    const skip = (detail: string): TestResult[] => [{ id: "H04", title: this.title, status: "skip", detail }];
    if (!ORG) return skip("PVLAB_ORG_PRO not set");
    for (const v of ["CLOUDFLARE_EMAIL", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (!process.env[v]) return skip(`${v} not set (wrangler Global API Key trio)`);
    }
    const skipQ1 = process.env.PVLAB_H04_SKIP_Q1 === "1";
    const skipQ2 = process.env.PVLAB_H04_SKIP_Q2 === "1";

    let ref = "";
    const configIds: string[] = [];
    const workerName = `h04-probe-${Date.now().toString(36)}`;
    let workdir = "";
    let deployed = false;
    const meas: Record<string, number | string> = {};
    const ev: string[] = [];
    const ipRe = /\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi;
    const red = (s: string) =>
      (ref ? s.replaceAll(ref, "<ref>") : s)
        .replace(ANSI, "")
        .replace(/postgres(ql)?:\/\/[^\s"]+/g, "<conn>")
        .replace(/accounts\/[0-9a-f]{32}/g, "accounts/<account>")
        .replace(ipRe, "<ip>")
        .replace(/port=\d+/g, "port=<n>")
        .replace(/\s+/g, " ");
    const note = (k: string, v: string) => ev.push(`${k}: ${red(v)}`);
    // Client addresses become per-run labels; no address is recorded.
    const addrLabels = new Map<string, string>();
    const addr = (a: string) => {
      if (!a) return "-";
      if (!addrLabels.has(a)) addrLabels.set(a, `${a.includes(":") ? "v6" : "v4"}#${addrLabels.size + 1}`);
      return addrLabels.get(a)!;
    };

    let base = "";
    const hd = async (b: "A" | "B" | "T", s: number, extra = ""): Promise<Hold & { body: Record<string, unknown> }> => {
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
    const parseSnap = (j: unknown, err: string): Snap => {
      const o = (j ?? {}) as { max_conn?: number; su_reserved?: number; by_role?: { u: string; n: number; idle: number; active: number }[]; rows?: Row[] };
      if (err || !o.by_role) return { ok: false, err: err || "no snapshot body", limit: -1, clients: -1, byRole: {}, rows: [] };
      const byRole: Snap["byRole"] = {};
      let clients = 0;
      for (const r of o.by_role) {
        byRole[r.u] = { n: r.n, idle: r.idle, active: r.active };
        clients += r.n;
      }
      return { ok: true, err: "", limit: (o.max_conn ?? 0) - (o.su_reserved ?? 0), clients, byRole, rows: o.rows ?? [] };
    };
    const snapB = async (roles: string[]): Promise<Snap> => {
      const r = await hd("B", 0, `&op=snap&roles=${roles.join(",")}`);
      return parseSnap(r.body.snap, r.ok ? "" : `${r.status} ${r.code} ${r.error}`.slice(0, 200));
    };
    const snapM = async (roles: string[]): Promise<Snap> => {
      const r = await sql(ctx, ref, `select public.h04_snap(array[${roles.map((x) => `'${x}'`).join(",")}]) as j`, 30_000);
      return parseSnap(r.rows?.[0]?.j, r.rows ? "" : red(`${r.status} ${r.error ?? ""}`).slice(0, 200));
    };
    const killM = async (role: string): Promise<number | string> => {
      const r = await sql(ctx, ref, `select public.h04_kill('${role}') as n`, 30_000);
      return r.rows ? Number(r.rows[0]?.n ?? -1) : `failed: ${red(r.error ?? "")}`.slice(0, 120);
    };
    const killB = async (role: string): Promise<number | string> => {
      const r = await hd("B", 0, `&op=kill&role=${role}`);
      return r.ok ? Number(r.body.n) : `B failed (${r.error.slice(0, 60)}), mgmt ${await killM(role)}`;
    };
    const roleStr = (s: Snap) => (s.ok ? Object.entries(s.byRole).sort().map(([k, v]) => `${k}:${v.n}`).join(" ") : `failed: ${s.err}`);

    let keys = { anon: "", service: "" };
    let host = "";
    /** A Data API call with the response headers kept (x-envoy-attempt-count). */
    const dapi = async (fn: string, args: unknown, timeoutMs: number, ua?: string) => {
      const r = await request(host, "POST", `/rest/v1/rpc/${fn}`, { apikey: keys.service, Authorization: `Bearer ${keys.service}`, ...(ua ? { "User-Agent": ua } : {}) }, args, timeoutMs);
      return { status: r.status, ms: r.ms, ok: r.status === 200, phase: "", error: red(r.status === 200 ? "" : r.message || r.body), code: r.code, attempts: r.headers["x-envoy-attempt-count"] ?? "-", bytes: r.body.length };
    };
    type D = Awaited<ReturnType<typeof dapi>>;
    /** status/code -> attempt-count histogram, e.g. `503/PGRST002 a6 x23 | 200 a1 x7`. */
    const attemptsBy = (xs: D[]) => fmtCounts(xs.reduce<Record<string, number>>((m, x) => {
      const k = `${x.status}${x.code ? `/${x.code}` : ""} a${x.attempts}`;
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {}));
    const put = (prefix: string, o: Record<string, string | number>) => {
      for (const [k, v] of Object.entries(o)) meas[`${prefix}_${k}`] = v;
    };
    const pingsUntil3 = async (): Promise<{ n: number; seen: D[] }> => {
      const seen: D[] = [];
      let okRun = 0;
      while (okRun < 3 && seen.length < 60) {
        const r = await dapi("dc_ping", {}, 15_000);
        seen.push(r);
        okRun = r.ok ? okRun + 1 : 0;
        if (okRun < 3) await sleep(2_000);
      }
      return { n: seen.length, seen };
    };
    const waitHealthy = async (maxS: number): Promise<string> => {
      const t0 = Date.now();
      let status = "";
      while (Date.now() - t0 < maxS * 1000) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
        status = String((p?.json as { status?: string } | undefined)?.status ?? "");
        if (status === "ACTIVE_HEALTHY") {
          const r = await sql(ctx, ref, "select 1 as one", 20_000);
          if (r.rows) return status;
        }
      }
      return status || "unknown";
    };

    try {
      // ---- provision -------------------------------------------------------
      const dbPass = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
      const tCreate = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `pvlab-h04-${Date.now()}`,
        db_pass: dbPass,
        region: REGION,
        desired_instance_size: "small",
      });
      ref = String((create.json as { ref?: string; id?: string } | undefined)?.ref ?? (create.json as { id?: string } | undefined)?.id ?? "");
      if (create.status !== 201 || !ref) throw new Error(`create project: HTTP ${create.status} ${create.text.slice(0, 200)}`);
      host = `${ref}.supabase.co`;
      const st0 = await waitHealthy(1200);
      if (st0 !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${st0}`);
      const ver = await sql(ctx, ref, "select version() as v");
      meas.region = REGION;
      meas.postgres_version = String(ver.rows?.[0]?.v ?? "").split(" on ")[0] ?? "";
      meas.project_ready_s = Math.round((Date.now() - tCreate) / 1000);

      // Connection and disconnection lines, before any Hyperdrive connection.
      const put0 = await mgmt(ctx, "PUT", `/projects/${ref}/config/database/postgres`, { log_connections: true, log_disconnections: true });
      meas.s_logcfg_put = `${put0.status} ${put0.status >= 300 ? red(put0.text).slice(0, 160) : ""}`.trim();
      const getCfg = await mgmt(ctx, "GET", `/projects/${ref}/config/database/postgres`);
      const cfg = (getCfg.json ?? {}) as Record<string, unknown>;
      meas.s_logcfg_get = `log_connections=${String(cfg.log_connections ?? "absent")} log_disconnections=${String(cfg.log_disconnections ?? "absent")}`;
      meas.s_logcfg_health_after = await waitHealthy(300);

      const setup = await sql(ctx, ref, SETUP_SQL);
      if (setup.error) throw new Error(`setup sql: ${setup.error}`);
      const pw = {
        A: `${crypto.randomUUID().replaceAll("-", "")}Aa1`,
        B: `${crypto.randomUUID().replaceAll("-", "")}Bb1`,
        T: `${crypto.randomUUID().replaceAll("-", "")}Tt1`,
      };
      const roles = await sql(ctx, ref, `create role hd_a login password '${pw.A}'; create role hd_b login password '${pw.B}'; create role hd_t login password '${pw.T}';`);
      if (roles.error) throw new Error(`create roles: ${roles.error}`);
      const obs = await sql(ctx, ref, OBSERVER_SQL);
      if (obs.error) throw new Error(`observer functions: ${obs.error}`);
      const s0 = await sql(ctx, ref, `select current_setting('max_connections')::int as max_connections,
          current_setting('superuser_reserved_connections')::int as su_reserved,
          current_setting('log_connections') as log_connections,
          current_setting('log_disconnections') as log_disconnections,
          current_setting('tcp_keepalives_idle') as tcp_keepalives_idle,
          current_setting('idle_session_timeout') as idle_session_timeout,
          (select coalesce(string_agg(rolname || ':' || array_to_string(rolconfig, ';'), ' '), 'none') from pg_roles where rolname in ('hd_a', 'hd_b', 'hd_t') and rolconfig is not null) as role_settings`);
      for (const [k2, v] of Object.entries(s0.rows?.[0] ?? { error: s0.error ?? "" })) meas[`s_${k2}`] = String(v ?? "null");

      const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const krows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
      keys = { anon: krows.find((x) => x.name === "anon")?.api_key ?? "", service: krows.find((x) => x.name === "service_role")?.api_key ?? "" };
      if (!keys.anon || !keys.service) throw new Error("legacy anon/service_role keys absent");
      for (let i = 0; i < 30; i++) {
        if ((await dapi("dc_ping", {}, 15_000)).ok) break;
        await sleep(2_000);
      }

      // ---- configs and Worker ---------------------------------------------
      workdir = await mkdtemp(join(tmpdir(), "h04-"));
      const dbHost = `db.${ref}.supabase.co`;
      const mk = async (name: string, user: string, pass: string, extra: string[]): Promise<string> => {
        const conn = `postgresql://${user}:${encodeURIComponent(pass)}@${dbHost}:5432/postgres`;
        let err = "";
        for (let i = 0; i < 6; i++) {
          try {
            // argv-secret-ok: wrangler hyperdrive create has no env path for the origin password; per-run random passwords of the project and roles this module creates and deletes (same exception as H01-H03)
            const out = await wrangler(["hyperdrive", "create", name, "--connection-string", conn, "--caching-disabled", ...extra], workdir);
            const id = out.match(/[0-9a-f]{32}/)?.[0] ?? "";
            if (id) {
              configIds.push(id);
              return id;
            }
            err = red(out).slice(0, 300);
          } catch (e) {
            err = red(e instanceof Error ? e.message : String(e)).slice(0, 300);
          }
          await sleep(15_000);
        }
        throw new Error(`hyperdrive create ${name}: ${err}`);
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
      const A = await mk(`${workerName}-a`, "hd_a", pw.A, []);
      const B = await mk(`${workerName}-b`, "hd_b", pw.B, ["--origin-connection-limit", "5"]);
      const T = await mk(`${workerName}-t`, "hd_t", pw.T, []);
      meas.s_config_a_origin_connection_limit = await readLimit(A);
      meas.s_config_b_origin_connection_limit = await readLimit(B);
      meas.s_config_t_origin_connection_limit = await readLimit(T);

      await writeFile(join(workdir, "worker.js"), WORKER);
      await writeFile(join(workdir, "wrangler.jsonc"), JSON.stringify({
        name: workerName,
        main: "worker.js",
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        hyperdrive: [{ binding: "HD_A", id: A }, { binding: "HD_B", id: B }, { binding: "HD_T", id: T }],
      }, null, 2));
      await run("bun", ["add", "pg@^8.16.3"], { cwd: workdir, timeout: 90_000 });
      meas.s_pg_driver_version = await run("bun", ["pm", "ls"], { cwd: workdir }).then((r) => r.stdout.match(/pg@([\d.]+)/)?.[1] ?? "?").catch(() => "?");
      meas.s_wrangler_version = await run("wrangler", ["--version"], { cwd: workdir }).then((r) => r.stdout.trim().split("\n").pop() ?? "?").catch(() => "?");
      // A failed deploy can still leave the script uploaded (the attempt
      // between runs 1 and 2 of 2026-10-26): mark it for deletion first, keep
      // the error's tail, retry.
      deployed = true;
      let deployOut = "";
      const deployErrs: string[] = [];
      for (let i = 0; i < 3 && !deployOut; i++) {
        try {
          deployOut = await wrangler(["deploy", "--config", "wrangler.jsonc"], workdir);
        } catch (e) {
          deployErrs.push(red(e instanceof Error ? e.message : String(e)).slice(-240));
          await sleep(15_000);
        }
      }
      if (deployErrs.length) meas.s_deploy_errors = deployErrs.join(" || ");
      if (!deployOut) throw new Error(`wrangler deploy failed 3 times: ${deployErrs.at(-1)}`);
      base = deployOut.match(/https:\/\/[^\s/]+\.workers\.dev/)?.[0] ?? "";
      if (!base) throw new Error(`no workers.dev URL in deploy output: ${red(deployOut).slice(0, 300)}`);
      /** 10 good answers in a row per binding (H02 run 1: 404s after a first good answer). */
      const warm = async (label: string) => {
        for (const b of ["A", "B", "T"] as const) {
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
          meas[`${label}_warmup_${b}`] = good >= 10 ? `ok after ${tries} bursts` : `not stable: ${last}`;
          if (good < 10) throw new Error(`binding ${b} not stable after ${label} warm-up: ${last}`);
        }
      };
      await warm("s");
      const tWarmEnd = Date.now();

      // ---- Q1 ----------------------------------------------------------------
      const tQ1 = Date.now();
      let tLoadEnd = 0;
      let tWatchEnd = 0;
      const life = new Map<number, Life>();
      if (!skipQ1) {
        // Management API kills: config B keeps its warm-up connections untouched.
        const killed: string[] = [];
        for (const role of ["hd_a", "hd_t"]) killed.push(`${role}:${await killM(role)}`);
        meas.q1_killed = killed.join(" ");
        await sleep(5_000);
        meas.q1_before_by_role = roleStr(await snapM(HD_ROLES));
        const fill = Promise.all([
          Promise.all(Array.from({ length: 40 }, () => hd("A", 20))),
          Promise.all(Array.from({ length: 20 }, () => hd("T", 20))),
        ]);
        await sleep(10_000);
        meas.q1_mid_fill_by_role = roleStr(await snapM(HD_ROLES));
        const [fa, ft] = await fill;
        put("q1_fill_A_k40_s20", summarise(fa));
        put("q1_fill_T_k20_s20", summarise(ft));
        tLoadEnd = Date.now();
        meas.q1_load_end_iso = new Date(tLoadEnd).toISOString();
        meas.q1_b_idle_since_warmup_s_at_load_end = Math.round((tLoadEnd - tWarmEnd) / 1000);

        // Trickle through T on its own schedule.
        const trickle: { t: number; ok: boolean; pid: number; ms: number; err: string }[] = [];
        const trickleDone = (async () => {
          for (let j = 1; j * TRICKLE_S <= TRICKLE_UNTIL_S; j++) {
            const due = tLoadEnd + j * TRICKLE_S * 1000;
            await sleep(Math.max(0, due - Date.now()));
            const r = await hd("T", 0);
            trickle.push({ t: Math.round((Date.now() - tLoadEnd) / 1000), ok: r.ok, pid: Number(r.body.pid ?? -1), ms: r.ms, err: r.ok ? "" : `${r.status} ${r.error}`.slice(0, 80) });
          }
        })();

        const counts: Record<string, string[]> = { hd_a: [], hd_b: [], hd_t: [] };
        const lastN: Record<string, number> = { hd_a: -1, hd_b: -1, hd_t: -1 };
        let samples = 0;
        let failed = 0;
        let maxGapMs = 0;
        let prevWall = 0;
        let prevMono = 0;
        let suspendedMs = 0;
        for (let i = 0; ; i++) {
          const due = tLoadEnd + i * SAMPLE_S * 1000;
          if (due - tLoadEnd > WATCH_S * 1000) break;
          await sleep(Math.max(0, due - Date.now()));
          const s = await snapM(HD_ROLES);
          const wall = Date.now();
          const mono = performance.now();
          if (prevWall) {
            maxGapMs = Math.max(maxGapMs, wall - prevWall);
            const d = wall - prevWall - (mono - prevMono);
            if (d > 2000) suspendedMs += d;
          }
          prevWall = wall;
          prevMono = mono;
          samples++;
          const t = Math.round((wall - tLoadEnd) / 1000);
          if (!s.ok) {
            failed++;
            continue;
          }
          const cur = new Set(s.rows.map((r) => r.pid));
          for (const [pid, l] of life) if (l.goneBy < 0 && !cur.has(pid)) l.goneBy = wall;
          for (const r of s.rows) {
            const qEnd = wall - r.sc * 1000;
            const l = life.get(r.pid);
            if (!l) {
              life.set(r.pid, { role: r.u, a: addr(r.a), firstSeen: wall, lastSeen: wall, goneBy: -1, lastQueryEnd: qEnd, uses: 0, stLast: r.st, q: r.q });
            } else {
              // A later query end by more than the rounding plus API latency is a new use.
              if (qEnd - l.lastQueryEnd > 3000) {
                l.uses++;
                l.lastQueryEnd = qEnd;
              }
              Object.assign(l, { lastSeen: wall, stLast: r.st, q: r.q });
            }
          }
          for (const role of HD_ROLES) {
            const n = s.rows.filter((r) => r.u === role).length;
            if (n !== lastN[role]) counts[role]!.push(`t+${t}s ${n}`);
            lastN[role] = n;
          }
        }
        tWatchEnd = Date.now();
        await trickleDone;
        meas.q1_samples = samples;
        meas.q1_samples_failed = failed;
        meas.q1_sample_s = SAMPLE_S;
        meas.q1_watch_s = WATCH_S;
        meas.q1_max_gap_between_samples_ms = maxGapMs;
        meas.q1_host_suspended_ms = Math.round(suspendedMs);
        meas.q1_trickle = trickle.map((x) => `t+${x.t}s ${x.ok ? `pid${x.pid}` : x.err} ${x.ms}ms`).join("; ");
        const trickledPids = new Set(trickle.filter((x) => x.ok).map((x) => x.pid));
        for (const role of HD_ROLES) {
          meas[`q1_${role}_count_changes`] = counts[role]!.join("; ");
          const ls = [...life.entries()].filter(([, l]) => l.role === role);
          meas[`q1_${role}_pids_seen`] = ls.length;
          meas[`q1_${role}_pids_open_at_end`] = ls.filter(([, l]) => l.goneBy < 0).length;
          meas[`q1_${role}_by_addr`] = fmtCounts(ls.reduce<Record<string, number>>((m, [, l]) => ((m[l.a] = (m[l.a] ?? 0) + 1), m), {}));
          // Idle at close from sampling: [last seen, first sample without it] minus last query end.
          const closed = ls.filter(([, l]) => l.goneBy > 0);
          const lo = closed.map(([, l]) => Math.round((l.lastSeen - l.lastQueryEnd) / 1000));
          const hi = closed.map(([, l]) => Math.round((l.goneBy - l.lastQueryEnd) / 1000));
          meas[`q1_${role}_closed_idle_s_bounds`] = closed.length ? `last seen idle ${range(lo)} s, gone by ${range(hi)} s (n=${closed.length})` : "none closed";
          meas[`q1_${role}_used_after_load_end`] = ls.filter(([, l]) => l.uses > 0).length;
        }
        meas.q1_trickle_distinct_pids = trickledPids.size;
        note("q1 pid lifecycle (s after load end: first-last seen, gone by, last query end; uses after load end)",
          [...life.entries()].sort((x, y) => x[1].role.localeCompare(y[1].role) || x[1].lastQueryEnd - y[1].lastQueryEnd)
            .map(([pid, l]) => `${l.role} pid${pid} ${l.a} seen ${s_(l.firstSeen - tLoadEnd)}-${s_(l.lastSeen - tLoadEnd)} gone ${l.goneBy > 0 ? s_(l.goneBy - tLoadEnd) : "open"} qend ${s_(l.lastQueryEnd - tLoadEnd)} uses ${l.uses}${trickledPids.has(pid) ? " trickled" : ""} ${l.stLast}`).join("; "));
      }

      // postgres_logs from load end on (the endpoint returns at most 1000 rows,
      // and the warm-up alone writes about 1000 connection lines): every
      // non-connection line of the hd_* roles (disconnections, FATAL, ERROR,
      // "could not receive data"), and new connections counted per role.
      const logsSince = async (sqlText: string, startMs: number) => {
        const qs = `sql=${encodeURIComponent(sqlText)}&iso_timestamp_start=${encodeURIComponent(new Date(startMs).toISOString())}&iso_timestamp_end=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`;
        const r = await mgmt(ctx, "GET", `/projects/${ref}/analytics/endpoints/logs?${qs}`, undefined, 60_000);
        const j = (r.json ?? {}) as { result?: Record<string, unknown>[]; error?: unknown };
        return { status: r.status, rows: Array.isArray(j.result) ? j.result : [], error: j.error ? JSON.stringify(j.error).slice(0, 200) : r.status >= 300 ? r.text.slice(0, 200) : "" };
      };
      const sessS = (m: string) => {
        const mm = m.match(/session time: (\d+):(\d+):([\d.]+)/);
        return mm ? Number(mm[1]) * 3600 + Number(mm[2]) * 60 + Number(mm[3]) : -1;
      };
      let discEvidence = "";
      const readPgLogs = async (): Promise<number> => {
        const from = tLoadEnd - 5_000;
        const r = await logsSince(
          `select timestamp, event_message, log_attributes['parsed.user_name'] as u, log_attributes['parsed.process_id'] as pid,
                  log_attributes['parsed.error_severity'] as sev, log_attributes['parsed.sql_state_code'] as code
             from logs where source = 'postgres_logs'
              and (log_attributes['parsed.user_name'] = 'hd_a' or log_attributes['parsed.user_name'] = 'hd_b' or log_attributes['parsed.user_name'] = 'hd_t')
              and event_message not like 'connection %'
            order by timestamp limit 1000`, from);
        const c = await logsSince(
          `select log_attributes['parsed.user_name'] as u, count() as n from logs where source = 'postgres_logs'
              and (log_attributes['parsed.user_name'] = 'hd_a' or log_attributes['parsed.user_name'] = 'hd_b' or log_attributes['parsed.user_name'] = 'hd_t') and event_message like 'connection authorized%'
            group by u order by u`, from);
        meas.q1_pglogs_connections_authorized_since_load_end = c.rows.map((x) => `${String(x.u)}:${String(x.n)}`).join(" ") || (c.error ? `error ${red(c.error)}` : "none");
        const rows = r.rows.map((x) => ({
          t: Date.parse(String(x.timestamp ?? "").replace(/Z?$/, "Z")),
          msg: String(x.event_message ?? ""),
          u: String(x.u ?? ""),
          pid: Number(x.pid ?? -1),
          sev: String(x.sev ?? ""),
          code: String(x.code ?? ""),
        }));
        meas.q1_pglogs_status = `${r.status}${r.error ? ` ${red(r.error)}` : ""}; ${rows.length} rows since load end`;
        // Distinct messages (session times folded before redaction) with count and first/last offset from load end.
        const g = new Map<string, number[]>();
        for (const x of rows) {
          const key = `${x.u || "-"} ${x.sev || "-"}${x.code ? `/${x.code}` : ""} ${red(x.msg.replace(/session time: [\d:.]+/, "session time: N")).slice(0, 110)}`;
          (g.get(key) ?? g.set(key, []).get(key)!).push(Math.round((x.t - tLoadEnd) / 1000));
        }
        meas.q1_pglogs_grouped = [...g.entries()].sort((p, q) => Math.min(...p[1]) - Math.min(...q[1]))
          .map(([key, ts]) => `${ts.length}x [${Math.min(...ts)}..${Math.max(...ts)}s] ${key}`).join(" | ").slice(0, 6000) || "none";
        // Disconnection lines matched to the watched pids.
        const disc = rows.filter((x) => /^disconnection: session time/.test(x.msg));
        const perRole: Record<string, { idle: number[]; sess: number[]; at: number[]; unmatched: number; usedIdle: number[] }> = {};
        for (const x of disc) {
          const e = (perRole[x.u || "?"] ??= { idle: [], sess: [], at: [], unmatched: 0, usedIdle: [] });
          const l = life.get(x.pid);
          e.sess.push(Math.round(sessS(x.msg)));
          e.at.push(Math.round((x.t - tLoadEnd) / 1000));
          if (!l) {
            e.unmatched++;
            continue;
          }
          const idle = Math.round((x.t - l.lastQueryEnd) / 1000);
          if (l.uses > 0) e.usedIdle.push(idle);
          else e.idle.push(idle);
        }
        for (const [role, e] of Object.entries(perRole)) {
          meas[`q1_disc_${role}_n`] = e.at.length;
          meas[`q1_disc_${role}_at_s`] = `${range(e.at)} (median ${median(e.at)})`;
          meas[`q1_disc_${role}_idle_s_untouched`] = e.idle.length ? `${range(e.idle)} (median ${median(e.idle)}, n=${e.idle.length})` : "none";
          meas[`q1_disc_${role}_idle_s_used_after_load_end`] = e.usedIdle.length ? `${range(e.usedIdle)} (n=${e.usedIdle.length})` : "none";
          meas[`q1_disc_${role}_session_s`] = range(e.sess);
          meas[`q1_disc_${role}_unmatched_pid`] = e.unmatched;
        }
        discEvidence = disc.map((x) => {
          const l = life.get(x.pid);
          return `${x.u} pid${x.pid} ${l?.a ?? "?"} t+${Math.round((x.t - tLoadEnd) / 1000)}s idle ${l ? Math.round((x.t - l.lastQueryEnd) / 1000) : "?"}s sess ${Math.round(sessS(x.msg))}s${l && l.uses > 0 ? " used" : ""}`;
        }).join("; ");
        return rows.length;
      };
      if (!skipQ1) {
        let prev = -1;
        for (let i = 0; i < 8; i++) {
          await sleep(20_000);
          const n = await readPgLogs().catch((e) => { meas.q1_pglogs_status = `threw: ${errText(e)}`; return -2; });
          if (n > 0 && n === prev) break;
          prev = n;
        }
        note("q1 disconnection lines since load end (role pid addr, s after load end, idle s since its last query, session s)", discEvidence || "none");
      }

      // ---- Q2 on another size ------------------------------------------------
      if (!skipQ2) {
        const from = await sql(ctx, ref, "select current_setting('max_connections')::int as m");
        const fromMax = Number(from.rows?.[0]?.m ?? -1);
        const p: DcProject = { ref, host, keys, userJwt: "", pgVersion: "", reused: false, createMs: tCreate, dbPass: "" };
        const tRz = Date.now();
        const rz = await resize(ctx, p, Q2_SIZE, -1, 25 * 60_000, 30, fromMax);
        meas.q2_resize = `${Q2_SIZE}: PATCH ${rz.status}${rz.text ? ` ${red(rz.text)}` : ""}, settled ${rz.settledS} s, max_connections ${fromMax} -> ${rz.maxConn}`;
        meas.q2_resize_iso = new Date(tRz).toISOString();
        if (rz.settledS < 0) throw new Error(`resize did not settle: ${rz.text}`);
        const pg = await mgmt(ctx, "GET", `/projects/${ref}/postgrest`).catch(() => undefined);
        const pj = (pg?.json ?? {}) as { db_pool?: number | null; db_pool_acquisition_timeout?: number | null };
        meas.q2_postgrest_db_pool = String(pj.db_pool ?? "null");
        meas.q2_postgrest_db_pool_acquisition_timeout = String(pj.db_pool_acquisition_timeout ?? "null");
        await warm("q2");
        meas.q2_after_warmup_by_role = roleStr(await snapB(["authenticator", ...HD_ROLES]));

        const armBurst: Record<string, number> = {};
        const armStart: Record<string, number> = {};
        const arm = async (label: string, o: { reset: boolean; warm: number; load: boolean; targetFree: number }) => {
          armStart[label] = Date.now();
          const killed: string[] = [];
          for (const role of ["hd_a", "hd_t", ...(o.reset ? ["authenticator"] : [])]) killed.push(`${role}:${await killB(role)}`);
          meas[`${label}_killed`] = killed.join(" ");
          await sleep(5_000);
          const pg3 = await pingsUntil3();
          meas[`${label}_pings_to_3_ok`] = pg3.n;
          meas[`${label}_pings_attempts`] = attemptsBy(pg3.seen);
          if (o.warm > 0) put(`${label}_warm`, summarise(await Promise.all(Array.from({ length: o.warm }, () => dapi("dc_sleep_xl", { s: 2 }, 60_000, `h04-${label}-warm`)))));
          let fillA: Promise<Hold[]> = Promise.resolve([]);
          let fillT: Promise<Hold[]> = Promise.resolve([]);
          let nT = 0;
          if (o.load) {
            fillA = Promise.all(Array.from({ length: 80 }, () => hd("A", 45)));
            await sleep(6_000);
            const mid = await snapB(["authenticator"]);
            const free = mid.ok ? mid.limit - mid.clients : 0;
            nT = Math.max(0, free - o.targetFree);
            meas[`${label}_mid_free_slots`] = mid.ok ? free : -1;
            fillT = Promise.all(Array.from({ length: nT }, () => hd("T", 35)));
            await sleep(6_000);
          }
          meas[`${label}_fill_t_holds`] = nT;
          const pre = await snapB(["authenticator"]);
          const prePids = new Set(pre.rows.map((r) => r.pid));
          meas[`${label}_pre_by_role`] = roleStr(pre);
          meas[`${label}_pre_free_slots`] = pre.ok ? pre.limit - pre.clients : -1;
          meas[`${label}_pre_pool`] = pre.rows.filter((r) => !r.q.startsWith("LISTEN")).length;
          const tB = Date.now();
          armBurst[label] = tB;
          meas[`${label}_burst_iso`] = new Date(tB).toISOString();
          const ua = `h04-${label}`;
          const pD = Promise.all(Array.from({ length: 30 }, () => dapi("dc_sleep_xl", { s: 5 }, 60_000, ua)));
          const pPing = dapi("dc_ping", {}, 60_000, ua);
          const snaps = await Promise.all([1500, 4500, 10_000].map(async (ms) => {
            await sleep(ms);
            return { ms, s: await snapB(["authenticator"]) };
          }));
          const [ds, ping] = await Promise.all([pD, pPing]);
          meas[`${label}_auth_series`] = snaps.map(({ ms, s }) => s.ok
            ? `+${ms / 1000}s auth=${s.byRole.authenticator?.n ?? 0} (kept ${s.rows.filter((r) => prePids.has(r.pid)).length}/${prePids.size}) clients=${s.clients}`
            : `+${ms / 1000}s failed ${s.err}`).join("; ");
          put(`${label}_dapi_k30_s5`, summarise(ds));
          meas[`${label}_dapi_attempts`] = attemptsBy(ds);
          meas[`${label}_ping`] = `${ping.status}${ping.code ? `/${ping.code}` : ""} a${ping.attempts} ${ping.ms} ms`;
          meas[`${label}_client_503s`] = [...ds, ping].filter((x) => x.status === 503).length;
          put(`${label}_fill_A`, summarise(await fillA));
          put(`${label}_fill_T`, summarise(await fillT));
        };
        await arm("q2a", { reset: true, warm: 0, load: false, targetFree: 0 });
        await arm("q2b", { reset: true, warm: 0, load: true, targetFree: 6 });
        await arm("q2c", { reset: false, warm: 12, load: true, targetFree: 3 });
        await arm("q2d", { reset: true, warm: 0, load: true, targetFree: 0 });
        const q2End = Date.now();

        // PostgREST access lines per arm: by status and body size.
        const readQ2Logs = async (): Promise<number> => {
          const r = await logsQuery({ ...ctx, ref }, "select timestamp, event_message from logs where source = 'postgrest_logs' and event_message like '%h04-q2%' order by timestamp limit 3000", 2);
          const rows = r.rows.map((x) => ({ t: Date.parse(String(x.timestamp ?? "").replace(/Z?$/, "Z")), msg: String(x.event_message ?? "") }));
          for (const lbl of Object.keys(armBurst)) {
            const mine = rows.filter((x) => x.msg.includes(`h04-${lbl}"`) || x.msg.includes(`h04-${lbl} `) || x.msg.endsWith(`h04-${lbl}`));
            const by: Record<string, number> = {};
            for (const x of mine) {
              const m = x.msg.match(/HTTP\/[\d.]+" (\d{3}) (\d+|-)/);
              const key = m ? `${m[1]} ${m[2]}B` : "?";
              by[key] = (by[key] ?? 0) + 1;
            }
            const tb = armBurst[lbl]!;
            meas[`${lbl}_logs_access_n`] = mine.length;
            meas[`${lbl}_logs_access_by_status_size`] = fmtCounts(by) || "none";
            meas[`${lbl}_logs_access_span_s`] = mine.length ? `${((Math.min(...mine.map((x) => x.t)) - tb) / 1000).toFixed(1)}..${((Math.max(...mine.map((x) => x.t)) - tb) / 1000).toFixed(1)}` : "none";
          }
          meas.q2_logs_status = `${r.status}${r.error ? ` ${red(r.error)}` : ""}; ${rows.length} rows`;
          return rows.length;
        };
        let prev = -1;
        const tW = Date.now();
        while (Date.now() - tW < 300_000) {
          await sleep(30_000);
          const n = await readQ2Logs().catch((e) => { meas.q2_logs_status = `threw: ${errText(e)}`; return -2; });
          if (n > 0 && n === prev) break;
          prev = n;
        }
        meas.q2_logs_waited_s = Math.round((Date.now() - tW) / 1000);
        meas.q2_span_s = Math.round((q2End - Math.min(...Object.values(armStart))) / 1000);
      }

      return [{
        id: "H04",
        title: this.title,
        status: "pass",
        detail: `measured; see measurements and evidence (the module records behaviour, it asserts none)${skipQ1 ? "; Q1 skipped" : ""}${skipQ2 ? "; Q2 skipped" : ""}`,
        measurements: meas,
        evidence: ev.join("\n"),
      }];
    } catch (e) {
      return [{
        id: "H04",
        title: this.title,
        status: "fail",
        detail: `threw: ${red(e instanceof Error ? e.message : String(e)).slice(0, 400)}`,
        measurements: meas,
        evidence: ev.join("\n"),
      }];
    } finally {
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

/** Seconds, rounded, for evidence lines. */
function s_(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
export default mod;
