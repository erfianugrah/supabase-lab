/**
 * H03 - two follow-ups from H02 (2026-10-23), one Small project (Pro org).
 *
 * Q1. Does Hyperdrive ever close idle origin connections to the direct
 * connection? H02 saw config A (no limit flag, read back 60) hold 60 idle
 * backends at every sample up to 891 s after load stopped; Cloudflare's limits
 * page lists a 10 minute idle connection timeout. Readings: a pool floor,
 * keepalive or health queries from Hyperdrive that keep the backends non-idle
 * by its own clock, or a timeout that does not apply to this path. What
 * separates them, per backend: `state_change` age (a query resets it),
 * `backend_start` age and pid continuity (recycling shows as new pids at a
 * steady count), the query text, and the client address (as a per-run label,
 * never the address).
 *
 * Q2. Why did the Data API answer 11 of 30 with 503 PGRST002 in H02e, after a
 * reset of PostgREST's connections, while Hyperdrive held 60? Readings: (a)
 * slot exhaustion (1 pool connection + 18 free slots = 19 answered); (b)
 * PostgREST dropped its pool and reloaded its schema cache on the failure.
 * Arms (each: Hyperdrive holds of 40 s, then 10 s later 30 dc_sleep_xl(5) and
 * one dc_ping):
 *
 *   Q2a  control: reset authenticator, no Hyperdrive load (does the reset
 *        alone give PGRST002?)
 *   Q2b  H02e again: reset authenticator, 80 holds through A (~18 free slots)
 *   Q2c  warm pool, no reset: 12 dc_sleep_xl(2) first so PostgREST holds idle
 *        connections, then 80 holds through A (~7 free)
 *   Q2d  few free: reset authenticator, 80 holds through A and 15 through C
 *        (~3 free)
 *
 * During each burst `authenticator` backends are read at 0.5, 1.5, 2.5, 3.5
 * and 4.5 s through config B's already-open connections (the Management API
 * is refused at the limit; H02), per pid, so a pool drop shows as pids gone
 * and a reconnect as pids new. postgrest_logs for each arm are read during
 * the Q1 watch (ingestion lags; with PVLAB_H03_SKIP_Q1=1, after Q2 until two
 * reads agree), grouped by message with count and first/last offset.
 *
 * Configs: A role hd_a, no limit flag; B role hd_b, limit 5 (observer);
 * C role hd_c, `--origin-connection-limit 15` (15, not 20: A 60 + C 15 +
 * PostgREST and Supabase backends leave the Management API observer headroom
 * under 87 even if one config overshoots its soft limit by a few, as B did by
 * 1 in H02 run 1). Q2 runs first; then every hd_*
 * and authenticator backend is terminated, A and C are filled (70 and 30
 * concurrent 20 s holds) and the watch samples pg_stat_activity through the
 * Management API every PVLAB_H03_SAMPLE_S (30) for PVLAB_H03_WATCH_S (1800)
 * with no Worker traffic at all. B's backends are terminated too and not
 * used again: a pool floor would show as B reconnecting by itself.
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
import { errText, fmtCounts, rpc, SETUP_SQL, sql } from "../../data-api-capacity/lib/dc.js";
import { ANSI, type Hold, summarise, wrangler } from "./h02-connection-budget.js";

const run = promisify(execFile);
const REGION = process.env.PVLAB_H03_REGION || "ap-southeast-1";
const WATCH_S = Number(process.env.PVLAB_H03_WATCH_S || 1800);
const SAMPLE_S = Number(process.env.PVLAB_H03_SAMPLE_S || 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HD_ROLES = ["hd_a", "hd_b", "hd_c"];

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
        const r = await client.query("select public.h03_snap($1::text[]) as j", [roles]);
        return Response.json({ ok: true, snap: r.rows[0].j, ms: Date.now() - t0 });
      }
      if (op === "kill") {
        const r = await client.query("select public.h03_kill($1) as n", [u.searchParams.get("role") ?? ""]);
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

// One function serves both observers: the Worker through config B (works at
// the limit) and the Management API as postgres (Q1, nowhere near it).
const OBSERVER_SQL = `
create or replace function public.h03_snap(roles text[]) returns json language sql security definer set search_path = pg_catalog as $$
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
create or replace function public.h03_kill(r text) returns int language sql security definer set search_path = pg_catalog as $$
  select count(pg_terminate_backend(pid))::int from pg_stat_activity where usename = r and pid <> pg_backend_pid() $$;
revoke all on function public.h03_snap(text[]), public.h03_kill(text) from public, anon, authenticated, service_role;
grant execute on function public.h03_snap(text[]), public.h03_kill(text) to hd_b;`;

interface Row { pid: number; u: string; st: string; we: string; sc: number; bs: number; q: string; a: string }
interface Snap {
  ok: boolean;
  err: string;
  /** Wall-clock ms when the snapshot answered. */
  at: number;
  limit: number;
  clients: number;
  byRole: Record<string, { n: number; idle: number; active: number }>;
  rows: Row[];
}

const mod: TestModule = {
  id: "H03",
  title: "Hyperdrive idle origin connections over 30 minutes; PGRST002 under Hyperdrive slot pressure, by arm",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ORG = ctx.orgs.pro ?? "";
    const skip = (detail: string): TestResult[] => [{ id: "H03", title: this.title, status: "skip", detail }];
    if (!ORG) return skip("PVLAB_ORG_PRO not set");
    for (const v of ["CLOUDFLARE_EMAIL", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (!process.env[v]) return skip(`${v} not set (wrangler Global API Key trio)`);
    }

    let ref = "";
    const configIds: string[] = [];
    const workerName = `h03-probe-${Date.now().toString(36)}`;
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
    // Client addresses become per-run labels; no address is recorded.
    const addrLabels = new Map<string, string>();
    const addr = (a: string) => {
      if (!a) return "-";
      if (!addrLabels.has(a)) addrLabels.set(a, `${a.includes(":") ? "v6" : "v4"}#${addrLabels.size + 1}`);
      return addrLabels.get(a)!;
    };

    let base = "";
    const hd = async (b: "A" | "B" | "C", s: number, extra = ""): Promise<Hold & { body: Record<string, unknown> }> => {
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
      if (err || !o.by_role) return { ok: false, err: err || "no snapshot body", at: Date.now(), limit: -1, clients: -1, byRole: {}, rows: [] };
      const byRole: Snap["byRole"] = {};
      let clients = 0;
      for (const r of o.by_role) {
        byRole[r.u] = { n: r.n, idle: r.idle, active: r.active };
        clients += r.n;
      }
      return { ok: true, err: "", at: Date.now(), limit: (o.max_conn ?? 0) - (o.su_reserved ?? 0), clients, byRole, rows: o.rows ?? [] };
    };
    /** Through config B's open origin connections (the observer that works at the limit). */
    const snapB = async (roles: string[]): Promise<Snap> => {
      const r = await hd("B", 0, `&op=snap&roles=${roles.join(",")}`);
      return parseSnap(r.body.snap, r.ok ? "" : `${r.status} ${r.code} ${r.error}`.slice(0, 200));
    };
    /** Through the Management API as postgres (Q1; refused at the limit). */
    const snapM = async (roles: string[]): Promise<Snap> => {
      const r = await sql(ctx, ref, `select public.h03_snap(array[${roles.map((x) => `'${x}'`).join(",")}]) as j`, 30_000);
      return parseSnap(r.rows?.[0]?.j, r.rows ? "" : red(`${r.status} ${r.error ?? ""}`).slice(0, 200));
    };
    const killM = async (role: string): Promise<number | string> => {
      const r = await sql(ctx, ref, `select public.h03_kill('${role}') as n`, 30_000);
      return r.rows ? Number(r.rows[0]?.n ?? -1) : `failed: ${red(r.error ?? "")}`.slice(0, 120);
    };
    /** Through config B (works at the limit); the Management API if B fails. */
    const killB = async (role: string): Promise<number | string> => {
      const r = await hd("B", 0, `&op=kill&role=${role}`);
      return r.ok ? Number(r.body.n) : `B failed (${r.error.slice(0, 60)}), mgmt ${await killM(role)}`;
    };
    const roleStr = (s: Snap) => (s.ok ? Object.entries(s.byRole).sort().map(([k, v]) => `${k}:${v.n}`).join(" ") : `failed: ${s.err}`);

    let keys = { anon: "", service: "" };
    let host = "";
    const dapi = async (fn: string, args: unknown, timeoutMs: number, ua?: string): Promise<Hold & { t: number }> => {
      const t = Date.now();
      const r = await rpc(host, fn, args, keys.service, keys.service, timeoutMs, ua);
      return { t, status: r.status, ms: r.ms, ok: r.status === 200, phase: "", error: red(r.status === 200 ? "" : (r.message || r.body)), code: r.code };
    };
    const put = (prefix: string, o: Record<string, string | number>) => {
      for (const [k, v] of Object.entries(o)) meas[`${prefix}_${k}`] = v;
    };
    const pingsUntil3 = async (): Promise<number> => {
      let pings = 0;
      let okRun = 0;
      while (okRun < 3 && pings < 60) {
        const r = await dapi("dc_ping", {}, 15_000);
        pings++;
        okRun = r.ok ? okRun + 1 : 0;
        if (okRun < 3) await sleep(2_000);
      }
      return pings;
    };

    try {
      // ---- provision -------------------------------------------------------
      const dbPass = `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
      const tCreate = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `pvlab-h03-${Date.now()}`,
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
      const pw = {
        A: `${crypto.randomUUID().replaceAll("-", "")}Aa1`,
        B: `${crypto.randomUUID().replaceAll("-", "")}Bb1`,
        C: `${crypto.randomUUID().replaceAll("-", "")}Cc1`,
      };
      const roles = await sql(ctx, ref, `create role hd_a login password '${pw.A}'; create role hd_b login password '${pw.B}'; create role hd_c login password '${pw.C}';`);
      if (roles.error) throw new Error(`create roles: ${roles.error}`);
      const obs = await sql(ctx, ref, OBSERVER_SQL);
      if (obs.error) throw new Error(`observer functions: ${obs.error}`);
      const s0 = await sql(ctx, ref, `select current_setting('max_connections')::int as max_connections,
          current_setting('superuser_reserved_connections')::int as su_reserved,
          pg_has_role('postgres', 'pg_read_all_stats', 'member') as postgres_read_all_stats,
          current_setting('tcp_keepalives_idle') as tcp_keepalives_idle,
          current_setting('idle_session_timeout') as idle_session_timeout,
          (select coalesce(string_agg(rolname || ':' || array_to_string(rolconfig, ';'), ' '), 'none') from pg_roles where rolname in ('hd_a', 'hd_b', 'hd_c', 'authenticator') and rolconfig is not null) as role_settings`);
      for (const [k2, v] of Object.entries(s0.rows?.[0] ?? { error: s0.error ?? "" })) meas[`s_${k2}`] = String(v ?? "null");

      const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const krows = (Array.isArray(k.json) ? k.json : []) as { name: string; api_key?: string }[];
      keys = { anon: krows.find((x) => x.name === "anon")?.api_key ?? "", service: krows.find((x) => x.name === "service_role")?.api_key ?? "" };
      if (!keys.anon || !keys.service) throw new Error("legacy anon/service_role keys absent");
      for (let i = 0; i < 30; i++) {
        if ((await rpc(host, "dc_ping", {}, keys.anon, keys.anon)).status === 200) break;
        await sleep(2_000);
      }
      const pgrst = await mgmt(ctx, "GET", `/projects/${ref}/postgrest`).catch(() => undefined);
      const pj = (pgrst?.json ?? {}) as { db_pool?: number | null; db_pool_acquisition_timeout?: number | null };
      meas.s_postgrest_db_pool = String(pj.db_pool ?? "null");
      meas.s_postgrest_db_pool_acquisition_timeout = String(pj.db_pool_acquisition_timeout ?? "null");

      // ---- configs and Worker ---------------------------------------------
      workdir = await mkdtemp(join(tmpdir(), "h03-"));
      const dbHost = `db.${ref}.supabase.co`;
      const mk = async (name: string, user: string, pass: string, extra: string[]): Promise<string> => {
        const conn = `postgresql://${user}:${encodeURIComponent(pass)}@${dbHost}:5432/postgres`;
        let err = "";
        for (let i = 0; i < 6; i++) {
          try {
            // argv-secret-ok: wrangler hyperdrive create has no env path for the origin password; per-run random passwords of the project and roles this module creates and deletes (same exception as H01, H02)
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
      const C = await mk(`${workerName}-c`, "hd_c", pw.C, ["--origin-connection-limit", "15"]);
      meas.s_config_a_origin_connection_limit = await readLimit(A);
      meas.s_config_b_origin_connection_limit = await readLimit(B);
      meas.s_config_c_origin_connection_limit = await readLimit(C);

      await writeFile(join(workdir, "worker.js"), WORKER);
      await writeFile(join(workdir, "wrangler.jsonc"), JSON.stringify({
        name: workerName,
        main: "worker.js",
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        hyperdrive: [{ binding: "HD_A", id: A }, { binding: "HD_B", id: B }, { binding: "HD_C", id: C }],
      }, null, 2));
      await run("bun", ["add", "pg@^8.16.3"], { cwd: workdir, timeout: 90_000 });
      meas.s_pg_driver_version = await run("bun", ["pm", "ls"], { cwd: workdir }).then((r) => r.stdout.match(/pg@([\d.]+)/)?.[1] ?? "?").catch(() => "?");
      meas.s_wrangler_version = await run("wrangler", ["--version"], { cwd: workdir }).then((r) => r.stdout.trim().split("\n").pop() ?? "?").catch(() => "?");
      const deployOut = await wrangler(["deploy", "--config", "wrangler.jsonc"], workdir);
      deployed = true;
      base = deployOut.match(/https:\/\/[^\s/]+\.workers\.dev/)?.[0] ?? "";
      if (!base) throw new Error(`no workers.dev URL in deploy output: ${red(deployOut).slice(0, 300)}`);
      // 10 good answers in a row per binding (H02 run 1: 404s after a first good answer).
      for (const b of ["A", "B", "C"] as const) {
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
        meas[`s_warmup_${b}`] = good >= 10 ? `ok after ${tries} bursts` : `not stable: ${last}`;
        if (good < 10) throw new Error(`binding ${b} not stable after warm-up: ${last}`);
      }
      const sw = await snapB(["authenticator"]);
      meas.s_after_warmup_by_role = roleStr(sw);

      // ---- Q2 arms ---------------------------------------------------------
      const q2Start = Date.now();
      const armBurst: Record<string, number> = {};
      const armStart: Record<string, number> = {};
      const arm = async (label: string, o: { reset: boolean; warm: number; fillA: number; fillC: number }) => {
        armStart[label] = Date.now();
        // Clear Hyperdrive holders left by the previous arm or the warm-up.
        const killed: string[] = [];
        for (const role of ["hd_a", "hd_c", ...(o.reset ? ["authenticator"] : [])]) killed.push(`${role}:${await killB(role)}`);
        meas[`${label}_killed`] = killed.join(" ");
        await sleep(5_000);
        meas[`${label}_pings_to_3_ok`] = await pingsUntil3();
        if (o.warm > 0) {
          put(`${label}_warm`, summarise(await Promise.all(Array.from({ length: o.warm }, () => dapi("dc_sleep_xl", { s: 2 }, 60_000, `h03-${label}-warm`)))));
        }
        const fills = Promise.all([
          ...Array.from({ length: o.fillA }, () => hd("A", 40)),
          ...Array.from({ length: o.fillC }, () => hd("C", 40)),
        ]);
        await sleep(10_000);
        const pre = await snapB(["authenticator"]);
        const prePids = new Set(pre.rows.map((r) => r.pid));
        meas[`${label}_pre_by_role`] = roleStr(pre);
        meas[`${label}_pre_clients`] = pre.clients;
        meas[`${label}_pre_free_slots`] = pre.ok ? pre.limit - pre.clients : -1;
        note(`${label} pre t+${at()}s authenticator`, pre.rows.map((r) => `pid${r.pid} ${r.st} bs${r.bs}s sc${r.sc}s [${r.q}]`).join("; "));
        // Burst, with authenticator snapshots inside the 5 s window.
        const tB = Date.now();
        armBurst[label] = tB;
        meas[`${label}_burst_iso`] = new Date(tB).toISOString();
        const ua = `h03-${label}`;
        const pD = Promise.all(Array.from({ length: 30 }, () => dapi("dc_sleep_xl", { s: 5 }, 60_000, ua)));
        const pPing = dapi("dc_ping", {}, 60_000, ua);
        const snaps = await Promise.all([500, 1500, 2500, 3500, 4500, 6500, 10_000].map(async (ms) => {
          await sleep(ms);
          return { ms, s: await snapB(["authenticator"]) };
        }));
        const [ds, ping] = await Promise.all([pD, pPing]);
        const series = snaps.map(({ ms, s }) => {
          if (!s.ok) return `+${ms / 1000}s failed ${s.err}`;
          const a = s.byRole.authenticator ?? { n: 0, idle: 0, active: 0 };
          const kept = s.rows.filter((r) => prePids.has(r.pid)).length;
          const fresh = s.rows.filter((r) => !prePids.has(r.pid)).length;
          const qs = [...new Set(s.rows.filter((r) => r.st === "active" && r.we !== "PgSleep").map((r) => r.q))].join(" || ");
          return `+${ms / 1000}s auth=${a.n} (active ${a.active}, idle ${a.idle}, sleeping ${s.rows.filter((r) => r.we === "PgSleep").length}, kept ${kept}/${prePids.size}, new ${fresh}) clients=${s.clients}${qs ? ` other-active [${qs}]` : ""}`;
        });
        meas[`${label}_auth_series`] = series.join("; ");
        put(`${label}_dapi_k30_s5`, summarise(ds));
        meas[`${label}_ping`] = `${ping.status}${ping.code ? `/${ping.code}` : ""} ${ping.ms} ms ${ping.error}`.slice(0, 200);
        // Order of outcomes by finish time (send times are equal).
        meas[`${label}_dapi_by_finish`] = [...ds].sort((x, y) => x.ms - y.ms).map((x) => `${x.status}${x.code ? `/${x.code}` : ""}@${x.ms}`).join(" ");
        put(`${label}_fill`, summarise(await fills));
        const post = await snapB(["authenticator"]);
        meas[`${label}_post_by_role`] = roleStr(post);
      };
      await arm("q2a", { reset: true, warm: 0, fillA: 0, fillC: 0 });
      await arm("q2b", { reset: true, warm: 0, fillA: 80, fillC: 0 });
      await arm("q2c", { reset: false, warm: 12, fillA: 80, fillC: 0 });
      await arm("q2d", { reset: true, warm: 0, fillA: 80, fillC: Number(process.env.PVLAB_H03_Q2D_FILL_C || 15) });
      const q2End = Date.now();

      // postgrest_logs per arm: the reset phase (kill to burst) and the burst
      // window (burst -1 s to +15 s), non-access lines verbatim; access lines
      // (those carrying the arm's User-Agent) counted, with one example whose
      // addresses are replaced. Run 1 of H03 capped all lines at 6000
      // characters in time order, which kept only the first arm's reset.
      const ipRe = /\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi;
      const readQ2Logs = async (): Promise<number> => {
        const r = await logsQuery({ ...ctx, ref }, "select timestamp, event_message from logs where source = 'postgrest_logs' order by timestamp limit 2000", 2);
        const rows = r.rows.map((x) => ({ t: Date.parse(String(x.timestamp ?? "").replace(/Z?$/, "Z")), msg: String(x.event_message ?? "") }));
        let inWin = 0;
        const labels = Object.keys(armBurst);
        for (const [i, lbl] of labels.entries()) {
          const tb = armBurst[lbl]!;
          const from = armStart[lbl]!;
          const to = i + 1 < labels.length ? armStart[labels[i + 1]!]! : q2End + 5_000;
          const fmt = (x: { t: number; msg: string }) => `${((x.t - tb) / 1000).toFixed(1)}s ${red(x.msg.replace(ipRe, "<ip>")).slice(0, 170)}`;
          // Distinct messages with count and first/last offset from the burst:
          // run 2 kept lines verbatim in order and the 4000-character cap cut
          // off everything after the first second (the recovery lines).
          const grouped = (xs: { t: number; msg: string }[]) => {
            const g = new Map<string, number[]>();
            for (const x of xs) {
              const k = red(x.msg.replace(ipRe, "<ip>")).replace(/\d+(\.\d+)? (milli)?seconds/g, "N $2seconds").slice(0, 150);
              (g.get(k) ?? g.set(k, []).get(k)!).push((x.t - tb) / 1000);
            }
            return [...g.entries()].sort((p, q) => Math.min(...p[1]) - Math.min(...q[1]))
              .map(([k2, ts]) => `${ts.length}x [${Math.min(...ts).toFixed(1)}..${Math.max(...ts).toFixed(1)}s] ${k2}`).join(" | ");
          };
          const mine = rows.filter((x) => x.t >= from && x.t < to);
          inWin += mine.length;
          const access = mine.filter((x) => x.msg.includes(`h03-${lbl}`));
          const other = mine.filter((x) => !x.msg.includes("h03-"));
          const reset = other.filter((x) => x.t < tb - 1_000);
          const win = other.filter((x) => x.t >= tb - 1_000 && x.t <= tb + 15_000);
          const after = other.filter((x) => x.t > tb + 15_000);
          meas[`${lbl}_logs_reset_n`] = reset.length;
          meas[`${lbl}_logs_reset`] = grouped(reset).slice(0, 4000) || "none";
          meas[`${lbl}_logs_burst_n`] = win.length;
          meas[`${lbl}_logs_burst`] = grouped(win).slice(0, 6000) || "none";
          meas[`${lbl}_logs_after_n`] = after.length;
          meas[`${lbl}_logs_after`] = grouped(after).slice(0, 3000) || "none";
          const st: Record<string, number> = {};
          for (const x of access) {
            const m = x.msg.match(/HTTP\/[\d.]+" (\d{3}) /)?.[1] ?? "?";
            st[m] = (st[m] ?? 0) + 1;
          }
          meas[`${lbl}_logs_access_statuses`] = fmtCounts(st) || "none";
          meas[`${lbl}_logs_access_n`] = access.length;
          meas[`${lbl}_logs_access_example`] = access[0] ? fmt(access[0]) : "none";
        }
        meas.q2_logs_status = `${r.status}${r.error ? ` ${r.error}` : ""}; ${r.rows.length} rows read, ${inWin} in the Q2 arms`;
        return inWin;
      };
      if (process.env.PVLAB_H03_SKIP_Q1 === "1") {
        // Q2 only: wait for ingestion until two reads agree (max 300 s).
        meas.q1_skipped = "PVLAB_H03_SKIP_Q1=1";
        let prev = -1;
        const tW = Date.now();
        while (Date.now() - tW < 300_000) {
          await sleep(30_000);
          const n = await readQ2Logs().catch((e) => { meas.q2_logs_status = `threw: ${errText(e)}`; return -2; });
          if (n > 0 && n === prev) break;
          prev = n;
        }
        meas.q2_logs_waited_s = Math.round((Date.now() - tW) / 1000);
        return [{ id: "H03", title: this.title, status: "pass", detail: "Q2 only (PVLAB_H03_SKIP_Q1=1); measured, asserts none", measurements: meas, evidence: ev.join("\n") }];
      }

      // ---- Q1 fill, then watch with no Worker traffic -----------------------
      const killed: string[] = [];
      for (const role of ["hd_a", "hd_c", "authenticator"]) killed.push(`${role}:${await killB(role)}`);
      killed.push(`hd_b:${await killM("hd_b")}`);
      meas.q1_killed = killed.join(" ");
      await sleep(5_000);
      meas.q1_pings_to_3_ok = await pingsUntil3();
      const before = await snapM(HD_ROLES);
      meas.q1_before_by_role = roleStr(before);
      const fill = Promise.all([
        Promise.all(Array.from({ length: 70 }, () => hd("A", 20))),
        Promise.all(Array.from({ length: 30 }, () => hd("C", 20))),
      ]);
      await sleep(10_000);
      const mid = await snapM(HD_ROLES);
      meas.q1_mid_fill_by_role = roleStr(mid);
      const [fa, fc] = await fill;
      put("q1_fill_A_k70_s20", summarise(fa));
      put("q1_fill_C_k30_s20", summarise(fc));
      const tLoadEnd = Date.now();
      meas.q1_load_end_iso = new Date(tLoadEnd).toISOString();

      interface Life { role: string; a: string; first: number; last: number; bsFirst: number; scLast: number; stLast: string; q: string }
      const life = new Map<number, Life>();
      const series: Record<string, string[]> = { hd_a: [], hd_b: [], hd_c: [] };
      const firstBelow: Record<string, number> = { hd_a: -1, hd_b: -1, hd_c: -1 };
      const peak: Record<string, number> = { hd_a: 0, hd_b: 0, hd_c: 0 };
      let prevPids = new Set<number>();
      let samples = 0;
      let failed = 0;
      let logsDone = false;
      let viaB = 0;
      // Written after every sample, so a throw later in the watch keeps the series.
      const flushQ1 = () => {
        meas.q1_watch_s = WATCH_S;
        meas.q1_sample_s = SAMPLE_S;
        meas.q1_samples = samples;
        meas.q1_samples_failed = failed;
        meas.q1_samples_via_b = viaB;
        for (const role of HD_ROLES) {
          meas[`q1_${role}_peak`] = peak[role]!;
          meas[`q1_${role}_first_below_peak_s`] = firstBelow[role]!;
          meas[`q1_${role}_series`] = series[role]!.join("; ");
          const ls = [...life.values()].filter((l) => l.role === role);
          meas[`q1_${role}_pids_seen`] = ls.length;
          meas[`q1_${role}_pids_until_end`] = ls.filter((l) => l.last === Math.max(...[...life.values()].map((x) => x.last))).length;
          meas[`q1_${role}_by_addr`] = fmtCounts(ls.reduce<Record<string, number>>((m, l) => ((m[l.a] = (m[l.a] ?? 0) + 1), m), {}));
        }
      };
      while (Date.now() - tLoadEnd < WATCH_S * 1000) {
        let s = await snapM(HD_ROLES);
        // Fallback if the Management API is refused (database full): config B,
        // which then holds a connection and is no longer a no-traffic config.
        if (!s.ok) {
          s = await snapB(HD_ROLES);
          if (s.ok) viaB++;
        }
        const t = Math.round((Date.now() - tLoadEnd) / 1000);
        samples++;
        if (!s.ok) {
          failed++;
          for (const r of HD_ROLES) series[r]!.push(`t+${t}s failed`);
        } else {
          const cur = new Set(s.rows.map((r) => r.pid));
          for (const role of HD_ROLES) {
            const rs = s.rows.filter((r) => r.u === role);
            const n = rs.length;
            peak[role] = Math.max(peak[role]!, n);
            if (n < peak[role]! && firstBelow[role]! < 0) firstBelow[role] = t;
            const sc = rs.map((r) => r.sc);
            const bs = rs.map((r) => r.bs);
            const states = fmtCounts(rs.reduce<Record<string, number>>((m, r) => ((m[r.st || "?"] = (m[r.st || "?"] ?? 0) + 1), m), {}));
            const qs = [...new Set(rs.map((r) => r.q))].join(" || ");
            const kept = rs.filter((r) => prevPids.has(r.pid)).length;
            const addrs = new Set(rs.map((r) => addr(r.a))).size;
            series[role]!.push(n
              ? `t+${t}s n=${n} ${states} sc=${Math.min(...sc)}-${Math.max(...sc)}s bs=${Math.min(...bs)}-${Math.max(...bs)}s kept=${kept} addrs=${addrs} q=[${qs}]`
              : `t+${t}s n=0`);
          }
          for (const r of s.rows) {
            const l = life.get(r.pid);
            if (l) Object.assign(l, { last: t, scLast: r.sc, stLast: r.st, q: r.q });
            else life.set(r.pid, { role: r.u, a: addr(r.a), first: t, last: t, bsFirst: r.bs, scLast: r.sc, stLast: r.st, q: r.q });
          }
          prevPids = cur;
          meas.q1_last_clients = s.clients;
          meas.q1_last_by_role = roleStr(s);
        }
        flushQ1();
        if (!logsDone && t >= 180) {
          await readQ2Logs().catch((e) => { meas.q2_logs_status = `threw: ${errText(e)}`; });
          logsDone = true;
        }
        await sleep(SAMPLE_S * 1000);
      }
      // Re-read at the end: ingestion may have lagged at the first read.
      await readQ2Logs().catch((e) => { meas.q2_logs_status = `threw: ${errText(e)}`; });

      flushQ1();
      note("q1 pid lifecycle (first/last seen s after load end, backend_start age at first sight, state_change age and state at last sight, query)",
        [...life.entries()].sort((x, y) => x[1].role.localeCompare(y[1].role) || x[1].first - y[1].first)
          .map(([pid, l]) => `${l.role} pid${pid} ${l.a} seen ${l.first}-${l.last}s bs0 ${l.bsFirst}s sc ${l.scLast}s ${l.stLast} [${l.q}]`).join("; "));

      return [{
        id: "H03",
        title: this.title,
        status: "pass",
        detail: "measured; see measurements and evidence (the module records behaviour, it asserts none)",
        measurements: meas,
        evidence: ev.join("\n"),
      }];
    } catch (e) {
      return [{
        id: "H03",
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
export default mod;
