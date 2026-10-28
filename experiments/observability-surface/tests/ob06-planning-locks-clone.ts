/**
 * OB06 - three observability checks on one micro project:
 * `pg_stat_statements.track_planning` for Data API traffic, whether the
 * project metrics endpoint shows lock waits, and whether the Management API
 * has a restore-to-new-project path.
 *
 * Question (generic): an app reads its database through the Data API
 * (PostgREST logs in as `authenticator` and switches role per request) and
 * wants planning time in `pg_stat_statements`; its operators scrape the
 * metrics endpoint and want to see sessions stuck behind locks.
 *
 * Claims under test:
 *   - Postgres applies `ALTER ROLE ... SET` at login only; `SET ROLE` does
 *     not apply the target role's settings (Postgres docs, ALTER ROLE).
 *   - PostgREST applies the impersonated role's settings per request
 *     (PostgREST docs, "Impersonated Role Settings"), so a setting on `anon`
 *     might reach Data API queries made as `anon` anyway.
 *   - `pg_stat_statements.track_planning` is not in the Management API's
 *     postgres-config schema (OpenAPI read 2026-10-28, `additionalProperties:
 *     false`).
 *   - The metrics endpoint refreshes about once a minute (docs).
 *
 * Rows:
 *   OB06a  `alter role <r> set pg_stat_statements.track_planning = on` for
 *          authenticator, authenticated, anon, postgres, service_role and
 *          `alter database postgres set ...`, run as `postgres` over a
 *          session-mode pooler connection: accepted or the error text.
 *   OB06b  `set role <r>` in a postgres session after the role setting: does
 *          `show` change? Plus a fresh postgres login after `alter role
 *          postgres set` as the positive control.
 *   OB06c  per arm (none, then each accepted setting alone): reload PostgREST
 *          config, terminate the authenticator backends, then as anon,
 *          authenticated and service_role read the setting through an RPC and
 *          send 3 GETs to a table unique to (arm, role); read `plans`,
 *          `total_plan_time` for that table's statement.
 *   OB06d  `PUT /v1/projects/{ref}/config/database/postgres` and `supabase
 *          postgres-config update --no-restart` with the key: HTTP status /
 *          exit and the value read back.
 *   OB06e  metrics endpoint: every family whose name matches
 *          lock|wait|activity|conflict|blocked|deadlock, with label keys and
 *          values (no sample values).
 *   OB06f  a row-lock wait and an ACCESS EXCLUSIVE wait, each held
 *          OB06_HOLD_S (default 130 s, two refresh periods), scraped every
 *          10 s with a 30 s baseline before and tail after: which series move
 *          while a session waits, and does any carry a wait-event label.
 *   OB06g  OpenAPI v1 and v2 documents: any clone / restore-to-new-project
 *          path or a source field in create-project; the routes RP01d probed.
 *          No clone is created.
 *
 * Not settled: other PostgREST versions, a pooled (Supavisor) Data API path,
 * metrics endpoint behaviour on other compute sizes, the Dashboard's clone
 * flow itself.
 *
 * DESTRUCTIVE: creates and deletes one project.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { connectSession, poolerConfig } from "../../replica-routing/lib/rr";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dropProject, makeProject, sleep, sql } from "../lib/ob";

const GUC = "pg_stat_statements.track_planning";
const TARGETS = ["authenticator", "authenticated", "anon", "postgres", "service_role", "database"] as const;
const REQ_ROLES = ["anon", "authenticated", "service_role"] as const;
const METRIC_RE = /lock|wait|activity|conflict|blocked|deadlock/i;
const HOLD_S = Number(process.env.OB06_HOLD_S ?? 130);
const SCRAPE_EVERY_MS = 10_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
const r2 = (n: number) => Math.round(n * 100) / 100;

function stmtFor(arm: string): string {
  const t = arm === "anongrant" ? "anon" : arm;
  return t === "database" ? `alter database postgres set ${GUC} = on` : `alter role ${t} set ${GUC} = on`;
}
function resetFor(arm: string): string {
  const t = arm === "anongrant" ? "anon" : arm;
  return t === "database" ? `alter database postgres reset ${GUC}` : `alter role ${t} reset ${GUC}`;
}

/* ---------- Prometheus text parsing ---------- */

interface Series {
  family: string;
  labels: Record<string, string>;
  key: string;
  value: number;
}
function parseProm(text: string): { types: Map<string, string>; series: Series[] } {
  const types = new Map<string, string>();
  const series: Series[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("# TYPE ")) {
      const [, , name, type] = line.split(" ");
      if (name && type) types.set(name, type);
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const name = m[1] ?? "";
    const labels: Record<string, string> = {};
    for (const lm of (m[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1] ?? ""] = lm[2] ?? "";
    let family = name;
    for (const suf of ["_bucket", "_sum", "_count", "_total", "_created"]) {
      if (name.endsWith(suf) && types.has(name.slice(0, -suf.length))) family = name.slice(0, -suf.length);
    }
    const key = `${name}{${Object.entries(labels)
      .filter(([k]) => k !== "supabase_project_ref" && k !== "service_type")
      .map(([k, v]) => `${k}=${v}`)
      .join(",")}}`;
    series.push({ family, labels, key, value: Number(m[4]) });
  }
  return { types, series };
}

const mod: TestModule = {
  id: "OB06",
  title: "track_planning for Data API queries, lock waits on the metrics endpoint, restore-to-new-project API",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB06", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    const clients: Client[] = [];
    try {
      const p = await makeProject(ctx, "ob06", undefined, "micro");
      ref = p.ref;
      const pc = p.ctx;
      const red = (s: string) => s.replaceAll(ref, "<ref>").replace(/[a-z0-9-]+\.pooler\.supabase\.com/g, "<pooler>");
      const base = `https://${ref}.supabase.co`;
      const apiKeys = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const secretKey = (Array.isArray(apiKeys.json) ? (apiKeys.json as { type?: string; api_key?: string }[]) : []).find((k) => k.type === "secret")?.api_key;

      const entry = (await poolerConfig(ctx, ref)).find((e) => e.database_type === "PRIMARY");
      if (!entry) throw new Error("no PRIMARY pooler entry");
      const pg = async () => {
        const c = await connectSession(entry, p.dbPass, 20, 10_000);
        clients.push(c);
        return c;
      };
      const admin = await pg();
      const who = (await admin.query("select current_user as u, version() as v, (select extnamespace::regnamespace::text from pg_extension where extname = 'pg_stat_statements') as ns")).rows[0];
      const pgss = `${who.ns}.pg_stat_statements`;
      const mgmtWho = await sql(pc, "select current_user as u");
      const gucInfo = (await admin.query("select context, setting from pg_settings where name = $1", [GUC])).rows[0] ?? {};
      const paramAcl = await admin
        .query("select parname, paracl::text from pg_parameter_acl where parname = $1", [GUC])
        .then((r) => r.rows[0]?.paracl ?? "none")
        .catch((e) => `error: ${errText(e)}`);

      /* ---------- schema: one table per (arm, role), the show RPC, the lock table ---------- */
      // anongrant: the anon setting again, after GRANT SET ON PARAMETER to authenticator (runs only if that grant is accepted).
      const arms = ["none", ...TARGETS, "anongrant"];
      const ddl = [
        `create or replace function public.ob06_show() returns json language sql stable as $$ select json_build_object('role', current_user, 'session_user', session_user, 'tp', current_setting('${GUC}'), 'pid', pg_backend_pid()) $$`,
        "create table public.ob06_lock (id int primary key, v int not null default 0)",
        "insert into public.ob06_lock (id) values (1)",
        ...arms.flatMap((a) => REQ_ROLES.map((r) => `create table public.ob06_q_${a}_${r} (id int primary key); insert into public.ob06_q_${a}_${r} values (1)`)),
        "notify pgrst, 'reload schema'",
      ];
      for (const s of ddl) await admin.query(s);

      // authenticated user for the authenticated role
      const service = pc.serviceKey ?? "";
      const email = `ob06-${Date.now()}@example.test`;
      const pw = `${crypto.randomUUID()}Aa1!`;
      const cu = await fetch(`${base}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw, email_confirm: true }),
      });
      const tok = await fetch(`${base}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: pc.anonKey ?? "", "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      }).then((r) => r.json() as Promise<{ access_token?: string }>);
      if (!tok.access_token) throw new Error(`no user token (admin create HTTP ${cu.status})`);
      const bearer: Record<string, string> = { anon: pc.anonKey ?? "", authenticated: tok.access_token, service_role: service };
      const rest = (path: string, role: string) =>
        fetch(`${base}/rest/v1/${path}`, { headers: { apikey: pc.anonKey ?? "", Authorization: `Bearer ${bearer[role]}` }, signal: AbortSignal.timeout(20_000) });

      /* ---------- OB06a: which ALTERs postgres may run ---------- */
      const accepted: Record<string, string> = {};
      for (const t of TARGETS) {
        try {
          await admin.query(stmtFor(t));
          accepted[t] = "ok";
          await admin.query(resetFor(t));
        } catch (e) {
          accepted[t] = errText(e);
        }
      }
      // PostgREST docs: impersonated-role settings with a privileged context
      // are skipped unless `GRANT SET ON PARAMETER <p> TO authenticator`.
      const grant = await admin
        .query(`grant set on parameter ${GUC} to authenticator`)
        .then(() => "ok")
        .catch((e) => errText(e));
      out.push({
        id: "OB06a",
        title: `ALTER ROLE / DATABASE SET ${GUC} as postgres`,
        status: "info",
        detail: TARGETS.map((t) => `${t}: ${accepted[t] === "ok" ? "accepted" : accepted[t]}`).join("; "),
        measurements: {
          pooler_session_user: String(who.u),
          mgmt_sql_user: String(mgmtWho.rows[0]?.u ?? mgmtWho.error),
          server_version: String(who.v).split(" ").slice(0, 2).join(" "),
          guc_context: String(gucInfo.context ?? ""),
          guc_default: String(gucInfo.setting ?? ""),
          parameter_acl: paramAcl,
          grant_set_on_parameter_to_authenticator: grant === "ok" ? "accepted" : grant,
          ...Object.fromEntries(TARGETS.map((t) => [`accepted_${t}`, accepted[t] === "ok" ? "yes" : "no"])),
        },
        evidence: [...TARGETS.map((t) => `${stmtFor(t)} -> ${accepted[t]}`), `grant set on parameter ${GUC} to authenticator -> ${grant}`].join("\n"),
      });

      /* ---------- OB06b: SET ROLE does not apply role settings ---------- */
      {
        const rows: string[] = [];
        const m: Record<string, string | number> = {};
        for (const t of TARGETS.filter((x) => x !== "database" && x !== "postgres" && accepted[x] === "ok")) {
          await admin.query(stmtFor(t));
          const s = await pg();
          const viaSetRole = await s
            .query(`set role ${t}`)
            .then(() => s.query(`show ${GUC}`))
            .then((r) => String(Object.values(r.rows[0] ?? {})[0]))
            .catch((e) => `error: ${errText(e)}`);
          await s.query("reset role").catch(() => {});
          await s.end().catch(() => {});
          await admin.query(resetFor(t));
          m[`set_role_${t}`] = viaSetRole;
          rows.push(`alter role ${t} set ...=on; new postgres session; set role ${t}; show -> ${viaSetRole}`);
        }
        if (accepted.postgres === "ok") {
          await admin.query(stmtFor("postgres"));
          // A session-mode pooler can hand a new client an existing backend, so
          // the first attempt (run 1) was not a fresh login. Drop the other
          // postgres backends first, then check the new backend's age.
          const killed = await admin
            .query("select count(*) filter (where pg_terminate_backend(pid))::int as n from pg_stat_activity where usename = 'postgres' and pid <> pg_backend_pid() and backend_type = 'client backend'")
            .then((r) => Number(r.rows[0]?.n ?? -1))
            .catch(() => -1);
          await sleep(2_000);
          const s = await pg();
          const r = await s.query(`select current_setting('${GUC}') as v, source, extract(epoch from now() - (select backend_start from pg_stat_activity where pid = pg_backend_pid()))::float8 as age from pg_settings where name = '${GUC}'`);
          const v = String(r.rows[0]?.v);
          await s.end().catch(() => {});
          await admin.query(resetFor("postgres"));
          m.fresh_postgres_login_after_alter_role_postgres = v;
          m.fresh_login_setting_source = String(r.rows[0]?.source ?? "");
          m.fresh_login_backend_age_s = r2(Number(r.rows[0]?.age ?? -1));
          m.postgres_backends_terminated_first = killed;
          rows.push(`alter role postgres set ...=on; other postgres backends terminated (${killed}); new login (backend ${r2(Number(r.rows[0]?.age ?? -1))} s old); show -> ${v}`);
        }
        out.push({ id: "OB06b", title: "SET ROLE versus login: does the role setting apply", status: "info", detail: rows.join("; ") || "no role setting accepted", measurements: m });
      }

      /* ---------- OB06c: arms through the Data API ---------- */
      const recycle = async (): Promise<{ terminated: number; readyMs: number }> => {
        await admin.query("notify pgrst, 'reload config'");
        await sleep(2_000);
        const t = await sql(pc, "select count(*) filter (where ok)::int as n from (select pg_terminate_backend(pid) as ok from pg_stat_activity where usename = 'authenticator' and pid <> pg_backend_pid()) x");
        const n = Number(t.rows[0]?.n ?? -1);
        const t0 = Date.now();
        let ok = 0;
        while (Date.now() - t0 < 60_000 && ok < 3) {
          const r = await rest("rpc/ob06_show", "anon").catch(() => null);
          ok = r?.status === 200 ? ok + 1 : 0;
          await sleep(1_000);
        }
        return { terminated: n, readyMs: Date.now() - t0 };
      };
      const armRows: string[] = [];
      accepted.anongrant = grant === "ok" ? (accepted.anon ?? "") : `GRANT SET ON PARAMETER refused: ${grant}`;
      for (const arm of arms) {
        if (arm !== "none" && accepted[arm] !== "ok") {
          out.push({ id: `OB06c-${arm}`, title: `Data API planning stats, setting on ${arm}`, status: "skip", detail: `not run: ${accepted[arm]}` });
          continue;
        }
        if (arm !== "none") await admin.query(stmtFor(arm));
        const rc = await recycle();
        const m: Record<string, string | number> = { authenticator_backends_terminated: rc.terminated, ready_ms: rc.readyMs };
        for (const role of REQ_ROLES) {
          const show = await rest("rpc/ob06_show", role)
            .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as { tp?: string; role?: string } }))
            .catch((e) => ({ status: 0, body: { tp: errText(e) } as { tp?: string; role?: string } }));
          const st: number[] = [];
          for (let i = 0; i < 3; i++) st.push(await rest(`ob06_q_${arm}_${role}?select=id`, role).then((r) => r.status).catch(() => 0));
          m[`${role}_rpc_status`] = show.status;
          m[`${role}_tp_in_request`] = String(show.body.tp ?? "");
          m[`${role}_get_statuses`] = st.join(",");
        }
        await sleep(1_000);
        const ss = await sql(
          pc,
          `select substring(query from 'ob06_q_[a-z_]+') as t, sum(calls)::int as calls, sum(plans)::int as plans, round(sum(total_plan_time)::numeric, 4)::float8 as plan_ms from ${pgss} where query ~ 'ob06_q_${arm}_' group by 1`,
        );
        for (const role of REQ_ROLES) {
          const row = ss.rows.find((x) => String(x.t) === `ob06_q_${arm}_${role}`);
          m[`${role}_calls`] = Number(row?.calls ?? 0);
          m[`${role}_plans`] = Number(row?.plans ?? 0);
          m[`${role}_plan_ms`] = r2(Number(row?.plan_ms ?? 0));
        }
        const perQuery = await sql(pc, `select calls::int as calls, plans::int as plans, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as q from ${pgss} where query ~ 'ob06_q_${arm}_' order by query`);
        if (arm !== "none") await admin.query(resetFor(arm));
        const planned = REQ_ROLES.filter((r) => Number(m[`${r}_plans`]) > 0);
        armRows.push(`${arm}: plans>0 for ${planned.join(",") || "none"}`);
        out.push({
          id: `OB06c-${arm}`,
          title: `Data API planning stats, setting on ${arm === "none" ? "nothing (baseline)" : arm}`,
          status: "info",
          detail: `plans>0 for ${planned.join(",") || "no role"}; in-request value ${REQ_ROLES.map((r) => `${r}=${m[`${r}_tp_in_request`]}`).join(" ")}`,
          measurements: m,
          evidence: red(ss.error || perQuery.rows.map((x) => `calls=${x.calls} plans=${x.plans} ${x.q}`).join("\n")),
        });
      }
      await recycle();

      /* ---------- OB06d: postgres-config API and CLI ---------- */
      {
        const before = await mgmt(ctx, "GET", `/projects/${ref}/config/database/postgres`);
        const put = await mgmt(ctx, "PUT", `/projects/${ref}/config/database/postgres`, { [GUC]: "on", restart_database: false });
        const afterPut = await mgmt(ctx, "GET", `/projects/${ref}/config/database/postgres`);
        // A temporary workdir: the CLI writes supabase/.temp/linked-project.json (carries the ref) wherever it runs.
        const cliDir = mkdtempSync(join(tmpdir(), "ob06-"));
        const cli = Bun.spawnSync(["supabase", "postgres-config", "update", "--project-ref", ref, "--config", `${GUC}=on`, "--no-restart", "--experimental", "--workdir", cliDir], {
          cwd: cliDir,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" },
          stdin: "ignore",
        });
        rmSync(cliDir, { recursive: true, force: true });
        const cliOut = red(`${cli.stdout.toString()}${cli.stderr.toString()}`).replace(/\s+/g, " ").trim().slice(0, 300);
        const afterCli = await mgmt(ctx, "GET", `/projects/${ref}/config/database/postgres`);
        const has = (j: unknown) => String((j as Record<string, unknown> | undefined)?.[GUC] ?? "absent");
        const live = await admin.query(`show ${GUC}`).then((r) => String(Object.values(r.rows[0] ?? {})[0])).catch((e) => `error: ${errText(e)}`);
        out.push({
          id: "OB06d",
          title: `postgres-config API and CLI with ${GUC}`,
          status: "info",
          detail: `PUT HTTP ${put.status}: ${red(put.text).slice(0, 160)}; CLI exit ${cli.exitCode}: ${cliOut.slice(0, 160)}`,
          measurements: {
            get_before_status: before.status,
            put_status: put.status,
            readback_after_put: has(afterPut.json),
            cli_exit: cli.exitCode ?? -1,
            readback_after_cli: has(afterCli.json),
            live_show_after: live,
          },
          evidence: `PUT body: ${red(put.text).slice(0, 400)}\nCLI: ${cliOut}`,
        });
      }

      /* ---------- OB06e/f: metrics endpoint ---------- */
      const auths: [string, string][] = [];
      if (secretKey) auths.push(["secret_key", secretKey]);
      auths.push(["legacy_service_role_jwt", service]);
      const authStatus: Record<string, number> = {};
      let useAuth = "";
      for (const [name, k] of auths) {
        const r = await fetch(`${base}/customer/v1/privileged/metrics`, { headers: { Authorization: `Basic ${btoa(`service_role:${k}`)}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
        authStatus[name] = r?.status ?? 0;
        await r?.text().catch(() => "");
        if (r?.status === 200 && !useAuth) useAuth = k;
      }
      if (!useAuth) throw new Error(`metrics endpoint refused every credential: ${JSON.stringify(authStatus)}`);
      const scrape = async () => {
        const t = Date.now();
        const r = await fetch(`${base}/customer/v1/privileged/metrics`, { headers: { Authorization: `Basic ${btoa(`service_role:${useAuth}`)}` }, signal: AbortSignal.timeout(30_000) });
        return { t, status: r.status, ...parseProm(await r.text()) };
      };
      const first = await scrape();
      const fams = new Map<string, { type: string; labels: Map<string, Set<string>>; n: number }>();
      for (const s of first.series) {
        if (!METRIC_RE.test(s.family)) continue;
        const f = fams.get(s.family) ?? { type: first.types.get(s.family) ?? "untyped", labels: new Map(), n: 0 };
        f.n++;
        for (const [k, v] of Object.entries(s.labels)) {
          if (k === "supabase_project_ref") continue;
          const set = f.labels.get(k) ?? new Set();
          set.add(v);
          f.labels.set(k, set);
        }
        fams.set(s.family, f);
      }
      const famList = [...fams.entries()].sort(([a], [b]) => a.localeCompare(b));
      const allFamilies = new Set(first.series.map((s) => s.family));
      const waitLabelSeries = first.series.filter((s) => Object.keys(s.labels).some((k) => /wait/i.test(k)) || Object.values(s.labels).some((v) => /^(Lock|LWLock|wait)/i.test(v)));
      out.push({
        id: "OB06e",
        title: "metrics endpoint: families matching lock|wait|activity|conflict|blocked|deadlock",
        status: "info",
        detail: `${famList.length} of ${allFamilies.size} families match: ${famList.map(([f]) => f).join(", ")}`,
        measurements: {
          ...Object.fromEntries(Object.entries(authStatus).map(([k, v]) => [`auth_${k}_http`, v])),
          families_total: allFamilies.size,
          series_total: first.series.length,
          families_matching: famList.length,
          series_with_wait_label: waitLabelSeries.length,
          series_with_state_label: first.series.filter((x) => "state" in x.labels).length,
          series_with_mode_label: first.series.filter((x) => "mode" in x.labels).length,
          pg_families: [...allFamilies].filter((f) => f.startsWith("pg_")).length,
        },
        evidence: red(`all pg_ families: ${[...allFamilies].filter((f) => f.startsWith("pg_")).sort().join(" ")}\n` + famList
          .map(([f, v]) => `${f} (${v.type}, ${v.n} series) labels: ${[...v.labels.entries()].map(([k, vals]) => `${k}=[${[...vals].sort().slice(0, 30).join("|")}]`).join(" ") || "none"}`)
          .join("\n")),
      });

      // OB06f: induce lock waits while scraping.
      const holder = await pg();
      const waiter = await pg();
      const watcher = await pg();
      const waiterPid = Number((await waiter.query("select pg_backend_pid() as p")).rows[0].p);
      type Sample = { t: number; phase: string; values: Map<string, number>; waiterWait: string; fp: string; fpNode: string };
      const samples: Sample[] = [];
      const t0 = Date.now();
      let phase = "baseline";
      let stop = false;
      const sampler = (async () => {
        while (!stop) {
          const s0 = Date.now();
          const sc = await scrape().catch(() => null);
          const w = await watcher
            .query("select coalesce(wait_event_type, '') || ':' || coalesce(wait_event, '') || ':' || state as w from pg_stat_activity where pid = $1", [waiterPid])
            .then((r) => String(r.rows[0]?.w ?? "gone"))
            .catch((e) => `error: ${errText(e)}`);
          if (sc) {
            const values = new Map<string, number>();
            for (const s of sc.series) if (METRIC_RE.test(s.family)) values.set(s.key, s.value);
            // Fingerprints of the pg_ and the node_ samples: each changes only
            // when that collector's values change (run 2 saw changes in pairs
            // 10 s apart, so the two are kept apart).
            const fpOf = (re: RegExp) =>
              sc.series
                .filter((s) => re.test(s.key))
                .map((s) => `${s.key}=${s.value}`)
                .sort()
                .join("|");
            samples.push({ t: Math.round((sc.t - t0) / 1000), phase, values, waiterWait: w, fp: fpOf(/^pg_/), fpNode: fpOf(/^node_/) });
          }
          await sleep(Math.max(0, SCRAPE_EVERY_MS - (Date.now() - s0)));
        }
      })();
      await sleep(30_000);
      // row lock
      phase = "row_wait";
      await holder.query("begin");
      await holder.query("select * from public.ob06_lock where id = 1 for update");
      const w1 = waiter.query("update public.ob06_lock set v = v + 1 where id = 1").catch((e) => errText(e));
      await sleep(HOLD_S * 1000);
      await holder.query("rollback");
      await w1;
      phase = "gap";
      await sleep(30_000);
      // access exclusive
      phase = "table_wait";
      await holder.query("begin");
      await holder.query("lock table public.ob06_lock in access exclusive mode");
      const w2 = waiter.query("select count(*) from public.ob06_lock").catch((e) => errText(e));
      await sleep(HOLD_S * 1000);
      await holder.query("rollback");
      await w2;
      phase = "tail";
      await sleep(30_000);
      stop = true;
      await sampler;

      // Which matching series differ between the wait phases and the no-wait phases?
      const keys = new Set<string>();
      for (const s of samples) for (const k of s.values.keys()) keys.add(k);
      const moved: string[] = [];
      const movedRow: string[] = [];
      const movedTable: string[] = [];
      const idle = samples.filter((s) => s.phase === "baseline" || s.phase === "gap" || s.phase === "tail");
      for (const k of keys) {
        const idleVals = new Set(idle.map((s) => s.values.get(k)).filter((v) => v !== undefined));
        const inRow = samples.filter((s) => s.phase === "row_wait").map((s) => s.values.get(k));
        const inTable = samples.filter((s) => s.phase === "table_wait").map((s) => s.values.get(k));
        const rowNew = inRow.some((v) => v !== undefined && !idleVals.has(v));
        const tableNew = inTable.some((v) => v !== undefined && !idleVals.has(v));
        if (rowNew) movedRow.push(k);
        if (tableNew) movedTable.push(k);
        if (rowNew || tableNew) moved.push(k);
      }
      // Distinct snapshots: scrapes whose pg_ (or node_) values differ from the previous scrape.
      const changes = (f: (x: Sample) => string) => {
        const at: number[] = [];
        for (let i = 1; i < samples.length; i++) if (f(samples[i] as Sample) !== f(samples[i - 1] as Sample)) at.push(samples[i]?.t ?? -1);
        return { at, gaps: at.slice(1).map((t, i) => t - (at[i] ?? 0)) };
      };
      const pgCh = changes((x) => x.fp);
      const nodeCh = changes((x) => x.fpNode);
      const changeAt = pgCh.at;
      const gaps = pgCh.gaps;
      const confirmedWaits = samples.filter((s) => s.waiterWait.startsWith("Lock:")).length;
      const keyTimeline = (k: string) => samples.map((s) => `${s.t}s/${s.phase}=${s.values.get(k) ?? "-"}`).join(" ");
      const interesting = [...keys].filter((k) => /state=active|state=idle in transaction|mode=|wait/i.test(k) || moved.includes(k));
      out.push({
        id: "OB06f",
        title: `metrics endpoint during a row-lock wait and an ACCESS EXCLUSIVE wait (${HOLD_S} s each, 10 s scrapes)`,
        status: "info",
        detail: `${samples.length} scrapes; waiter seen in pg_stat_activity as Lock in ${confirmedWaits}; matching series that took a value only seen during a wait: row ${movedRow.length}, table ${movedTable.length}; series with a wait-event label: ${waitLabelSeries.length}`,
        measurements: {
          scrapes: samples.length,
          scrapes_waiter_in_lock_wait: confirmedWaits,
          pg_snapshot_changes: changeAt.length,
          pg_snapshot_gap_min_s: gaps.length ? Math.min(...gaps) : -1,
          pg_snapshot_gap_max_s: gaps.length ? Math.max(...gaps) : -1,
          node_snapshot_changes: nodeCh.at.length,
          node_snapshot_gap_min_s: nodeCh.gaps.length ? Math.min(...nodeCh.gaps) : -1,
          node_snapshot_gap_max_s: nodeCh.gaps.length ? Math.max(...nodeCh.gaps) : -1,
          moved_row_wait: movedRow.length,
          moved_table_wait: movedTable.length,
          moved_keys: red(moved.slice(0, 20).join(" ; ")) || "none",
          series_with_wait_label: waitLabelSeries.length,
        },
        evidence: red([
          `waiter state per scrape: ${samples.map((s) => `${s.t}s/${s.phase}=${s.waiterWait}`).join(" ")}`,
          `pg_ values changed at (s): ${changeAt.join(" ")}`,
          `node_ values changed at (s): ${nodeCh.at.join(" ")}`,
          ...interesting.slice(0, 40).map((k) => `${k}: ${keyTimeline(k)}`),
        ].join("\n")),
      });

      /* ---------- OB06g: restore-to-new-project in the OpenAPI documents ---------- */
      {
        const get = async (u: string) => fetch(u, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json() as Promise<{ paths?: Record<string, Record<string, { summary?: string }>>; components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } }>);
        const v1 = await get("https://api.supabase.com/api/v1-json");
        const v2 = await get("https://api.supabase.com/api/v2-json").catch(() => ({}) as typeof v1);
        const paths = [...Object.keys(v1.paths ?? {}), ...Object.keys(v2.paths ?? {})];
        const restoreish = paths.filter((x) => /clone|restore|backup|fork|duplicate|copy/i.test(x));
        const createFields = Object.keys(v1.components?.schemas?.V1CreateProjectBody?.properties ?? {});
        const branchFields = Object.keys(v1.components?.schemas?.CreateBranchBody?.properties ?? {});
        const platformClone = await fetch(`https://api.supabase.com/platform/database/${ref}/clone`, { headers: { Authorization: `Bearer ${ctx.pat}` }, signal: AbortSignal.timeout(30_000) })
          .then(async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`)
          .catch((e) => errText(e));
        const v1Clone = await mgmt(ctx, "GET", `/projects/${ref}/clone`);
        out.push({
          id: "OB06g",
          title: "restore to a new project: Management API surface (no clone created)",
          status: "info",
          detail: `clone paths ${paths.filter((x) => /clone/i.test(x)).length}; create-project fields: ${createFields.join(",")}; dashboard clone route with PAT: ${red(platformClone)}`,
          measurements: {
            v1_path_count: Object.keys(v1.paths ?? {}).length,
            v2_path_count: Object.keys(v2.paths ?? {}).length,
            clone_paths: paths.filter((x) => /clone/i.test(x)).length,
            create_body_source_like_fields: createFields.filter((f) => /clone|restore|source|backup|from/i.test(f)).join(",") || "none",
            branch_body_with_data: String(branchFields.includes("with_data")),
            v1_clone_route_http: v1Clone.status,
            dashboard_clone_route_with_pat: red(platformClone),
          },
          evidence: `restore/backup-ish paths:\n${restoreish
            .map((x) => {
              const ops = { ...(v1.paths?.[x] ?? {}), ...(v2.paths?.[x] ?? {}) };
              return `${x}: ${Object.entries(ops)
                .map(([m, o]) => `${m.toUpperCase()} ${o.summary ?? ""}`)
                .join(" | ")}`;
            })
            .join("\n")}`,
        });
      }
    } catch (e) {
      out.push({ id: "OB06", title: "OB06", status: "fail", detail: `threw: ${ref ? errText(e).replaceAll(ref, "<ref>") : errText(e)}` });
    } finally {
      for (const c of clients) await c.end().catch(() => {});
      const d = await dropProject(ctx, ref);
      out.push({ id: "OB06z", title: "teardown", status: d < 300 || d === 404 ? "pass" : "fail", detail: `delete HTTP ${d}` });
    }
    return out;
  },
};
export default mod;
