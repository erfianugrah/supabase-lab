/**
 * Shared scenario for the branching-nogit modules (BN01-BN03).
 *
 * One scenario = one throwaway parent project in the Pro org, one preview
 * branch created WITHOUT git (`POST /projects/{ref}/branches`, no
 * `git_branch`), a schema change applied to the BRANCH by one or two paths,
 * `GET /branches/{ref}/diff`, `POST /branches/{ref}/merge`, and a poll of
 * the PARENT until the window closes. The three modules differ only in
 * which write path carries the change:
 *
 *   BN01  the dashboard SQL path: `POST /projects/{branch_ref}/database/query`
 *   BN02  the same objects under two names, one set via `/database/query`
 *         and one via `POST /projects/{branch_ref}/database/migrations`,
 *         merged together, so both paths face the same merge
 *   BN03  the BN01 change plus `PATCH /branches/{ref} {request_review: true}`
 *         (the API half of the dashboard's "merge request" step) before merge
 *
 * Object set (prefix p): table `p_t` with RLS enabled, a SELECT policy
 * `p_own`, privileges narrowed (anon none, authenticated SELECT only), a
 * function `p_fn`, plus a column `p_col` and an index `p_idx` on the baseline
 * table that exists on the parent. The platform's default privileges grant
 * every privilege on new public tables to anon and authenticated, so a plain
 * GRANT would be invisible; the REVOKEs make the privilege change observable.
 *
 * Row ids are `<module id>` + a..f: a parent and baseline, b branch create and
 * schema arrival, c writes on the branch, d diff, e merge and the parent,
 * f teardown.
 */
import type { Ctx, TestResult } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const BASE = "bn_base";

export type Meas = Record<string, number | string>;

/** mgmt() with a retry on throttle/429 (api.supabase.com answers polling with an HTML 429). */
export async function call(ctx: Ctx, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<MgmtResponse> {
  let last: MgmtResponse | undefined;
  for (let i = 0; i < 4; i++) {
    try {
      last = await mgmt(ctx, method, path, body, timeoutMs);
    } catch (e) {
      last = { status: 0, text: `ERR ${e instanceof Error ? e.message : String(e)}`, throttled: false };
    }
    // classifyBody flagged the 200 body of GET /diff as throttled in run 2 (cause not investigated), so `throttled` only counts on a non-200
    if (last.status === 200 || (last.status !== 429 && !last.throttled && last.status !== 0)) return last;
    ctx.log(`${method} ${path.replace(/[a-z]{20}/g, "<ref>")}: HTTP ${last.status}${last.throttled ? " (throttled)" : ""}, retry ${i + 1}`);
    await sleep(10_000 * (i + 1));
  }
  return last as MgmtResponse;
}

export interface QueryResult {
  status: number;
  rows: Record<string, unknown>[];
  error: string;
}

/** `POST /projects/{ref}/database/query`: the dashboard SQL editor's path (ref may be a branch ref). */
export async function query(ctx: Ctx, ref: string, sqlText: string): Promise<QueryResult> {
  const r = await call(ctx, "POST", `/projects/${ref}/database/query`, { query: sqlText });
  const rows = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  const error = r.status >= 300 ? String((r.json as Record<string, unknown> | undefined)?.message ?? r.text).replace(/\s+/g, " ").slice(0, 240) : "";
  return { status: r.status, rows, error };
}

export async function migrations(ctx: Ctx, ref: string): Promise<{ status: number; names: string[] }> {
  const r = await call(ctx, "GET", `/projects/${ref}/database/migrations`);
  const arr = Array.isArray(r.json) ? (r.json as { name?: string }[]) : [];
  return { status: r.status, names: arr.map((m) => m.name ?? "?") };
}

export async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    const p = await call(ctx, "GET", `/projects/${ref}`);
    status = (p.json as { status?: string } | undefined)?.status ?? "";
    if (status !== "ACTIVE_HEALTHY") await sleep(10_000);
  }
  return status;
}

/** The change set for prefix `p`, as separate statements (one HTTP call each on the query path). */
export function changeSet(p: string): { label: string; sql: string }[] {
  const t = `public.${p}_t`;
  return [
    { label: "table", sql: `create table ${t}(id bigint generated always as identity primary key, owner uuid, body text)` },
    { label: "rls", sql: `alter table ${t} enable row level security` },
    { label: "policy", sql: `create policy ${p}_own on ${t} for select to authenticated using (owner = auth.uid())` },
    { label: "grants", sql: `revoke all on ${t} from anon; revoke all on ${t} from authenticated; grant select on ${t} to authenticated` },
    { label: "function", sql: `create function public.${p}_fn(a int) returns int language sql immutable as $$ select a + 1 $$` },
    { label: "column", sql: `alter table public.${BASE} add column ${p}_col text` },
    { label: "index", sql: `create index ${p}_idx on public.${BASE}(${p}_col)` },
  ];
}

export interface Snap {
  tbl: string;
  rls: string;
  policy: number;
  acl_auth: string;
  acl_anon: string;
  fn: number;
  col: number;
  idx: number;
}

const acl = (t: string, role: string) =>
  `coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a where c.oid = to_regclass('${t}') and a.grantee = (select oid from pg_roles where rolname = '${role}')), '')`;

export function snapSql(p: string): string {
  const t = `public.${p}_t`;
  return `select
    coalesce(to_regclass('${t}')::text, '') as tbl,
    coalesce((select relrowsecurity::text from pg_class where oid = to_regclass('${t}')), '') as rls,
    (select count(*) from pg_policies where schemaname = 'public' and tablename = '${p}_t' and policyname = '${p}_own')::int as policy,
    ${acl(t, "authenticated")} as acl_auth,
    ${acl(t, "anon")} as acl_anon,
    (select count(*) from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = '${p}_fn')::int as fn,
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = '${BASE}' and column_name = '${p}_col')::int as col,
    (select count(*) from pg_indexes where schemaname = 'public' and indexname = '${p}_idx')::int as idx`;
}

export async function snap(ctx: Ctx, ref: string, p: string): Promise<Snap | { error: string }> {
  const r = await query(ctx, ref, snapSql(p));
  if (r.status >= 300 || !r.rows[0]) return { error: `HTTP ${r.status} ${r.error}` };
  return r.rows[0] as unknown as Snap;
}

/** 1 when every object of the set is present on that side. */
export function complete(s: Snap | { error: string }): boolean {
  return "tbl" in s && s.tbl !== "" && s.rls === "true" && s.policy === 1 && s.acl_auth === "SELECT" && s.acl_anon === "" && s.fn === 1 && s.col === 1 && s.idx === 1;
}

export function flatten(p: string, s: Snap | { error: string }): Meas {
  if ("error" in s) return { [`${p}_state`]: `unread: ${s.error}` };
  return {
    [`${p}_table`]: s.tbl === "" ? "absent" : "present",
    [`${p}_rls`]: s.rls === "true" ? "on" : s.tbl === "" ? "n/a" : "off",
    [`${p}_policy`]: s.policy ? "present" : "absent",
    [`${p}_acl_authenticated`]: s.tbl === "" ? "n/a" : s.acl_auth || "none",
    [`${p}_acl_anon`]: s.tbl === "" ? "n/a" : s.acl_anon || "none",
    [`${p}_function`]: s.fn ? "present" : "absent",
    [`${p}_column`]: s.col ? "present" : "absent",
    [`${p}_index`]: s.idx ? "present" : "absent",
  };
}

const mentions = (text: string, re: RegExp) => (re.test(text) ? 1 : 0);

/** What a diff body mentions, as 0/1 flags (prefix = the variant name). */
export function diffFlags(variant: string, status: number, text: string, sets: string[]): Meas {
  const m: Meas = { [`${variant}_http`]: status, [`${variant}_chars`]: text.length };
  for (const p of sets) {
    m[`${variant}_${p}_table`] = mentions(text, new RegExp(`${p}_t\\b`));
    m[`${variant}_${p}_policy`] = mentions(text, new RegExp(`${p}_own`));
    m[`${variant}_${p}_function`] = mentions(text, new RegExp(`${p}_fn`));
    m[`${variant}_${p}_column`] = mentions(text, new RegExp(`${p}_col`));
    m[`${variant}_${p}_index`] = mentions(text, new RegExp(`${p}_idx`));
    m[`${variant}_${p}_revoke_or_grant`] = mentions(text, new RegExp(`(revoke|grant)[^;]*${p}_t`, "is"));
  }
  m[`${variant}_pg_net`] = mentions(text, /pg_net/);
  m[`${variant}_drop_baseline`] = mentions(text, new RegExp(`drop table[^;]*${BASE}`, "i"));
  return m;
}

export type Path = "query" | "mixed";

export interface Spec {
  id: string; // module id, e.g. BN01
  title: string;
  /** `query`: set `q` through /database/query. `mixed`: set `q` through it and set `m` through /database/migrations. */
  path: Path;
  /** PATCH request_review before merging. */
  requestReview?: boolean;
}

interface Branch {
  id: string;
  ref: string;
}

export async function runScenario(ctx: Ctx, spec: Spec): Promise<TestResult[]> {
  const out: TestResult[] = [];
  const id = spec.id;
  const row = (suffix: string, title: string, status: TestResult["status"], detail: string, measurements?: Meas, evidence?: string) =>
    out.push({ id: `${id}${suffix}`, title: `${id}${suffix}: ${title}`, status, detail, measurements, evidence });
  const org = ctx.orgs.pro ?? "";
  if (!org) return [{ id, title: spec.title, status: "skip", detail: "no Pro org (set PVLAB_ORG_PRO)" }];

  const sets = spec.path === "mixed" ? ["q", "m"] : ["q"];
  let parent = "";
  let branch: Branch | undefined;
  const t0 = Date.now();
  try {
    // ---- a: parent project + baseline table (written on the parent through the SQL path, no migration file)
    const create = await call(ctx, "POST", "/projects", {
      organization_slug: org,
      name: `bn-${id.toLowerCase()}-${t0}`,
      db_pass: `${crypto.randomUUID()}Aa1!`,
      region_selection: { type: "specific", code: "ap-southeast-1" },
    });
    parent = (create.json as { ref?: string } | undefined)?.ref ?? "";
    if (!parent) {
      row("a", "parent project", "fail", `create HTTP ${create.status}: ${create.text.slice(0, 200)}`);
      return out;
    }
    ctx.log(`[${id}] parent created (${Math.round((Date.now() - t0) / 1000)} s), waiting healthy`);
    const health = await waitHealthy(ctx, parent);
    const base = await query(ctx, parent, `create table public.${BASE}(id bigint primary key, note text); insert into public.${BASE} values (1, 'parent-row')`);
    const pm = await migrations(ctx, parent);
    row("a", "parent project and baseline table written through the SQL path", health === "ACTIVE_HEALTHY" && base.status < 300 ? "pass" : "fail",
      `create HTTP ${create.status}; ${health}; baseline HTTP ${base.status}; parent migration history before branching: ${pm.names.length} row(s)`,
      { create_http: create.status, health, baseline_http: base.status, parent_migrations_before_branch: pm.status === 200 ? pm.names.length : `HTTP ${pm.status}` });

    // ---- b: git-less branch; healthy; when does the parent's schema arrive
    const tb = Date.now();
    const bc = await call(ctx, "POST", `/projects/${parent}/branches`, { branch_name: `${id.toLowerCase()}-probe`, region: "ap-southeast-1", with_data: false }, 180_000);
    const bj = (bc.json ?? {}) as { id?: string; project_ref?: string; persistent?: boolean; with_data?: boolean };
    const createMs = Date.now() - tb;
    if (bc.status >= 300 || !bj.project_ref) {
      row("b", "branch create", "fail", `HTTP ${bc.status}: ${bc.text.slice(0, 200)}`, { create_http: bc.status });
      return out;
    }
    branch = { id: bj.id ?? "", ref: bj.project_ref };
    let healthyS: number | string = "never";
    let baseAtHealthy: number | string = "unread";
    let pullS: number | string = "never";
    let steps = "";
    for (let i = 0; i < 90; i++) {
      const g = await call(ctx, "GET", `/branches/${branch.ref}`);
      const st = (g.json as { status?: string } | undefined)?.status ?? "";
      if (st === "ACTIVE_HEALTHY") {
        healthyS = Math.round((Date.now() - tb) / 1000);
        const b = await query(ctx, branch.ref, `select to_regclass('public.${BASE}')::text as t`);
        baseAtHealthy = b.status < 300 ? (b.rows[0]?.t ? 1 : 0) : `HTTP ${b.status}`;
        break;
      }
      await sleep(10_000);
    }
    // Provisioned != propagated: the branch reports healthy before the parent's schema is on it, and
    // the workflow run's `pull` step can read EXITED while `migrate` is still CREATED (BN01/BN02,
    // 2026-10-10 run 3). The observable is the baseline table itself, polled for up to 6 min; the
    // step list is recorded alongside.
    let baseSeenS: number | string = "never";
    let baseAfter: number | string = 0;
    for (let i = 0; i < 36; i++) {
      const bq = await query(ctx, branch.ref, `select to_regclass('public.${BASE}')::text as t`);
      baseAfter = bq.status < 300 ? (bq.rows[0]?.t ? 1 : 0) : `HTTP ${bq.status}`;
      const a = await call(ctx, "GET", `/projects/${branch.ref}/actions`);
      const run = (Array.isArray(a.json) ? (a.json as { run_steps?: { name: string; status: string }[] }[]) : [])[0];
      steps = (run?.run_steps ?? []).map((s) => `${s.name}=${s.status}`).join(",");
      if (pullS === "never" && run?.run_steps?.some((s) => s.name === "pull" && s.status === "EXITED")) pullS = Math.round((Date.now() - tb) / 1000);
      if (baseAfter === 1) {
        baseSeenS = Math.round((Date.now() - tb) / 1000);
        break;
      }
      await sleep(10_000);
    }
    ctx.log(`[${id}] branch healthy after ${healthyS} s, baseline seen after ${baseSeenS} s, pull step exited after ${pullS} s`);
    const bm = await migrations(ctx, branch.ref);
    const pm2 = await migrations(ctx, parent);
    row("b", "git-less branch: create, healthy, parent schema arrival", healthyS !== "never" && baseAfter === 1 ? "pass" : "fail",
      `create HTTP ${bc.status} in ${createMs} ms; healthy after ${healthyS} s; baseline table on the branch at healthy: ${baseAtHealthy}; baseline table first seen on the branch after ${baseSeenS} s; pull step first read EXITED after ${pullS} s; workflow steps at last read: ${steps}`,
      {
        create_http: bc.status, create_ms: createMs, persistent: String(bj.persistent ?? ""), with_data: String(bj.with_data ?? ""),
        healthy_s: healthyS, baseline_on_branch_at_healthy: baseAtHealthy, baseline_first_seen_s: baseSeenS, pull_step_exited_s: pullS, baseline_on_branch_at_last_read: baseAfter, workflow_steps_at_last_read: steps,
        branch_migrations_after_pull: bm.status === 200 ? bm.names.join("|") : `HTTP ${bm.status}`,
        parent_migrations_after_branch: pm2.status === 200 ? pm2.names.join("|") : `HTTP ${pm2.status}`,
      });
    if (healthyS === "never") return out;

    // ---- c: write the change set on the BRANCH
    const wr: Meas = {};
    const details: string[] = [];
    let okCount = 0;
    let total = 0;
    for (const s of changeSet("q")) {
      const r = await query(ctx, branch.ref, s.sql);
      total++;
      if (r.status < 300) okCount++;
      else details.push(`q ${s.label}: HTTP ${r.status} ${r.error}`);
    }
    wr.query_path_ok = `${okCount} of ${total}`;
    const ins = await query(ctx, branch.ref, `insert into public.q_t(body) values ('branch-row') returning id`);
    wr.query_path_insert_http = ins.status;
    if (spec.path === "mixed") {
      const mig = await call(ctx, "POST", `/projects/${branch.ref}/database/migrations`, {
        query: changeSet("m").map((s) => s.sql.replace(/;?\s*$/, "")).join(";\n") + ";",
        name: "bn_m_change",
      });
      wr.migrations_path_http = mig.status;
      if (mig.status >= 300) details.push(`m migration: HTTP ${mig.status} ${mig.text.slice(0, 160)}`);
    }
    if (spec.requestReview) {
      const rv = await call(ctx, "PATCH", `/branches/${branch.ref}`, { request_review: true });
      wr.request_review_http = rv.status;
      const ls = await call(ctx, "GET", `/projects/${parent}/branches`);
      const me = (Array.isArray(ls.json) ? (ls.json as Record<string, unknown>[]) : []).find((x) => x.project_ref === branch!.ref);
      wr.review_requested_at_set = me?.review_requested_at ? 1 : 0;
      if (rv.status >= 300) details.push(`request_review: HTTP ${rv.status} ${rv.text.slice(0, 160)}`);
    }
    const bmig = await migrations(ctx, branch.ref);
    wr.branch_migrations_after_writes = bmig.status === 200 ? bmig.names.join("|") : `HTTP ${bmig.status}`;
    const bsnap = await Promise.all(sets.map((p) => snap(ctx, branch!.ref, p)));
    sets.forEach((p, i) => Object.assign(wr, Object.fromEntries(Object.entries(flatten(p, bsnap[i]!)).map(([k, v]) => [`branch_${k}`, v]))));
    const psnapPre = await Promise.all(sets.map((p) => snap(ctx, parent, p)));
    wr.parent_has_any_before_merge = psnapPre.some((s) => "tbl" in s && s.tbl !== "") ? 1 : 0;
    row("c", "change set written on the branch; branch holds it; parent does not", bsnap.every(complete) && wr.parent_has_any_before_merge === 0 ? "pass" : "fail",
      `${details.join("; ") || "all writes accepted"}; branch holds the complete set(s): ${bsnap.every(complete)}; parent holds any before merge: ${wr.parent_has_any_before_merge}`, wr);

    ctx.log(`[${id}] change set written (${Math.round((Date.now() - t0) / 1000)} s since start)`);
    // ---- d: diff, three variants
    const dm: Meas = {};
    const texts: Record<string, string> = {};
    for (const [name, qs] of [["default", ""], ["pgdelta", "?pgdelta=true"], ["migra", "?pgdelta=false"]] as const) {
      const d = await call(ctx, "GET", `/branches/${branch.ref}/diff${qs}`, undefined, 180_000);
      texts[name] = d.text;
      Object.assign(dm, diffFlags(name, d.status, d.text, sets));
    }
    dm.default_equals_migra = texts.default === texts.migra ? 1 : 0;
    row("d", "GET /diff: default, pgdelta=true, pgdelta=false", "info",
      `default ${texts.default?.length} chars, pgdelta=true ${texts.pgdelta?.length} chars, pgdelta=false ${texts.migra?.length} chars; default identical to pgdelta=false: ${dm.default_equals_migra}`,
      dm, `--- pgdelta=true ---\n${(texts.pgdelta ?? "").slice(0, 3000)}\n--- pgdelta=false ---\n${(texts.migra ?? "").slice(0, 3000)}`);

    ctx.log(`[${id}] diffs read`);
    // ---- e: merge, then poll the PARENT
    const tm = Date.now();
    const mg = await call(ctx, "POST", `/branches/${branch.ref}/merge`, {}, 180_000);
    const runId = (mg.json as { workflow_run_id?: string } | undefined)?.workflow_run_id ?? "";
    const WINDOW_MS = 240_000;
    const firstSeen: Record<string, number | string> = { q: "never", m: "never" };
    let last: (Snap | { error: string })[] = [];
    while (Date.now() - tm < WINDOW_MS) {
      await sleep(10_000);
      last = await Promise.all(sets.map((p) => snap(ctx, parent, p)));
      sets.forEach((p, i) => {
        const s = last[i]!;
        if (firstSeen[p] === "never" && "tbl" in s && s.tbl !== "") firstSeen[p] = Math.round((Date.now() - tm) / 1000);
      });
      // early exit only when the migration-history set landed and had 30 s to finish; a null result waits the full window
      const m = sets.indexOf("m");
      if (m >= 0 && complete(last[m]!) && Date.now() - tm > 30_000 + (typeof firstSeen.m === "number" ? firstSeen.m * 1000 : 0)) break;
    }
    ctx.log(`[${id}] merge window closed`);
    const em: Meas = { merge_http: mg.status, merge_body_ok: String((mg.json as { message?: string } | undefined)?.message ?? mg.text.slice(0, 80)), workflow_run_id_returned: runId ? 1 : 0, observed_s: Math.round((Date.now() - tm) / 1000) };
    sets.forEach((p, i) => {
      Object.assign(em, flatten(p, last[i]!));
      em[`${p}_first_seen_s`] = firstSeen[p] ?? "never";
    });
    const a = await call(ctx, "GET", `/projects/${parent}/actions`);
    const run = (Array.isArray(a.json) ? (a.json as { id?: string; run_steps?: { name: string; status: string }[] }[]) : []).find((r) => r.id === runId);
    em.merge_run_steps = (run?.run_steps ?? []).map((s) => `${s.name}=${s.status}`).join(",") || "run not listed";
    const pAfter = await migrations(ctx, parent);
    em.parent_migrations_after_merge = pAfter.status === 200 ? pAfter.names.join("|") : `HTTP ${pAfter.status}`;
    const pg = await query(ctx, parent, `select count(*)::int as n from pg_extension where extname = 'pg_net'`);
    em.parent_pg_net_extension = (pg.rows[0]?.n as number | undefined) ?? "unread";
    if (last.length && "tbl" in last[0]! && last[0]!.tbl !== "") {
      const rc = await query(ctx, parent, `select count(*)::int as n from public.q_t`);
      em.q_t_rows_on_parent = (rc.rows[0]?.n as number | undefined) ?? `HTTP ${rc.status}`;
    }
    const landed = sets.map((p, i) => `${p}=${complete(last[i]!) ? "complete" : "table " + (("tbl" in last[i]! && (last[i] as Snap).tbl) ? "present, set incomplete" : "absent")}`).join(", ");
    row("e", "POST /merge, then the parent over a fixed window", "info",
      `merge HTTP ${mg.status}; after ${em.observed_s} s the parent has: ${landed}; parent migration history: ${em.parent_migrations_after_merge}`, em);
  } catch (e) {
    row("x", "scenario threw", "fail", e instanceof Error ? e.message : String(e));
  } finally {
    // ---- f: teardown. Branches bill per hour; the project is deleted last.
    ctx.log(`[${id}] teardown (${Math.round((Date.now() - t0) / 1000)} s since start)`);
    const gm: Meas = {};
    if (branch) {
      const del = await call(ctx, "DELETE", `/branches/${branch.ref}`);
      gm.branch_delete_http = del.status;
      let goneS: number | string = "never";
      const td = Date.now();
      for (let i = 0; i < 36; i++) {
        const l = await call(ctx, "GET", `/projects/${parent}/branches`);
        const still = Array.isArray(l.json) && (l.json as { project_ref?: string }[]).some((b) => b.project_ref === branch!.ref);
        if (!still) {
          goneS = Math.round((Date.now() - td) / 1000);
          break;
        }
        await sleep(10_000);
      }
      gm.branch_gone_s = goneS;
    }
    if (parent) {
      const pd = await call(ctx, "DELETE", `/projects/${parent}`);
      gm.parent_delete_http = pd.status;
      await sleep(10_000);
      const all = await call(ctx, "GET", "/projects");
      const left = (Array.isArray(all.json) ? (all.json as { name?: string; ref?: string }[]) : []).filter((p) => p.ref === parent || p.ref === branch?.ref).length;
      gm.refs_left_in_listing = left;
    }
    row("f", "teardown: branch deleted, parent deleted", gm.refs_left_in_listing === 0 && (gm.branch_delete_http === undefined || gm.branch_delete_http === 200) ? "pass" : "info",
      `branch DELETE ${gm.branch_delete_http ?? "n/a"}, gone from the parent's list after ${gm.branch_gone_s ?? "n/a"} s; parent DELETE ${gm.parent_delete_http ?? "n/a"}; this scenario's refs still in GET /projects: ${gm.refs_left_in_listing ?? "n/a"}`, gm);
  }
  return out;
}
