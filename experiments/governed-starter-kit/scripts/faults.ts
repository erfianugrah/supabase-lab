/**
 * Reversible faults for the troubleshooting + observability segment
 * (docs/OBSERVABILITY.md). Ready project only.
 *
 *   bun scripts/faults.ts inject <ref> <slow-activity|summary-error|all>
 *   bun scripts/faults.ts traffic <ref> [rounds]   app-path calls as seeded users
 *   bun scripts/faults.ts check <ref> [--wait]     advisors, logs, pg_stat_statements
 *   bun scripts/faults.ts timing <ref>             EXPLAIN ANALYZE as a user, as
 *                                                  injected and with the fix
 *                                                  (fix rolled back, never kept)
 *   bun scripts/faults.ts clear <ref>              drop the fault objects, then
 *                                                  prove the inventory matches
 *                                                  the pre-inject snapshot
 *
 * The fault SQL is sql/40-faults.sql, one `-- fault:` section per fault. The
 * faults live in their own objects (public.activity_events,
 * public.activity_summary) so the example app, the in-app agent and K01/K02
 * never touch them.
 *
 * `inject` records a schema inventory (relations, columns, grants, indexes,
 * policies, functions, triggers, constraints, migration-history rows) and the
 * advisor findings in evidence/faults-<ref>.json (gitignored) before changing
 * anything. `clear` drops the fault objects plus anything a coding agent hung
 * off them (indexes, policies, migration rows that name them), resets their
 * pg_stat_statements entries, re-takes the inventory and exits non-zero if it
 * differs from the snapshot. Log lines already ingested cannot be removed; the
 * clean check therefore looks only at the window after the clear.
 *
 * Env: SUPABASE_ACCESS_TOKEN (all commands); DB_PASSWORD and POOLER_HOST for
 * `timing` (psql through lib/pg.ts). KIT_LIVE_REF, when set, is refused.
 * Seeded-user passwords come from evidence/users-<ref>.json. Nothing secret is
 * printed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ctx } from "../../../harness/src/types";
import { asUser } from "../lib/pg";

const API = "https://api.supabase.com/v1";
const TOK = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!TOK) throw new Error("no SUPABASE_ACCESS_TOKEN in the environment");

const FAULTS = ["slow-activity", "summary-error"] as const;
type Fault = (typeof FAULTS)[number];
// summary-error reads the activity table, so it brings slow-activity with it.
const NEEDS: Record<Fault, Fault[]> = { "slow-activity": [], "summary-error": ["slow-activity"] };
const FAULT_RE = "activity_(events|summary)";
const FEED = "/rest/v1/activity_events?select=id,kind,created_at,actor_id&order=created_at.desc&limit=50";
const SUMMARY = "/rest/v1/rpc/activity_summary";

interface Lint {
  name: string;
  level: string;
  detail: string;
  cache_key: string;
}
interface State {
  injectedAt: string;
  faults: Fault[];
  inventory: Record<string, string>;
  lints: string[];
}

async function mgmt(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function sql<T = Record<string, unknown>>(ref: string, query: string): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    const r = await mgmt("POST", `/projects/${ref}/database/query`, { query });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : [];
    if (attempt >= 4 || (r.status < 500 && r.status !== 429)) {
      throw new Error(`sql http ${r.status}: ${text.slice(0, 400)}`);
    }
    await Bun.sleep(5_000 * attempt);
  }
}

const statePath = (ref: string) => `evidence/faults-${ref}.json`;
const readState = (ref: string): State | null =>
  existsSync(statePath(ref)) ? (JSON.parse(readFileSync(statePath(ref), "utf8")) as State) : null;
const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z");

// --- inventory: everything a fault or a fix could add, keyed by kind + name ---

const INVENTORY = `
select kind || ' ' || name as k, md5(coalesce(def, '')) as h from (
  select 'relation' as kind, format('%I.%I', n.nspname, c.relname) as name,
         concat_ws('|', c.relkind, c.relrowsecurity, c.relacl::text,
           (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || coalesce(a.attacl::text, ''), ',' order by a.attnum)
              from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) as def
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'index', schemaname || '.' || indexname, indexdef from pg_indexes where schemaname in ('public', 'private')
  union all
  select 'policy', schemaname || '.' || tablename || '.' || policyname, concat_ws('|', cmd, roles::text, qual, with_check)
    from pg_policies where schemaname in ('public', 'private')
  union all
  select 'function', p.oid::regprocedure::text, pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
  union all
  select 'trigger', t.tgrelid::regclass::text || '.' || t.tgname, pg_get_triggerdef(t.oid)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal and n.nspname in ('public', 'private', 'auth')
  union all
  select 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    from pg_constraint where connamespace in (select oid from pg_namespace where nspname in ('public', 'private'))
  union all
  select 'type', format('%I.%I', n.nspname, t.typname), t.typtype::text
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname in ('public', 'private') and t.typtype in ('e', 'd', 'c')
     and not exists (select 1 from pg_class c where c.reltype = t.oid)
) x`;

async function migrationsTable(ref: string): Promise<boolean> {
  const r = await sql<{ t: string | null }>(ref, "select to_regclass('supabase_migrations.schema_migrations')::text as t");
  return Boolean(r[0]?.t);
}

async function inventory(ref: string): Promise<Record<string, string>> {
  const rows = await sql<{ k: string; h: string }>(ref, INVENTORY);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.k] = r.h;
  if (await migrationsTable(ref)) {
    const m = await sql<{ version: string; h: string }>(
      ref,
      "select version, md5(coalesce(name, '') || coalesce(statements::text, '')) as h from supabase_migrations.schema_migrations",
    );
    for (const r of m) out[`migration ${r.version}`] = r.h;
  }
  return out;
}

function diff(before: Record<string, string>, after: Record<string, string>): string[] {
  const d: string[] = [];
  for (const k of Object.keys(after)) if (!(k in before)) d.push(`+ ${k}`);
  for (const k of Object.keys(before)) if (!(k in after)) d.push(`- ${k}`);
  for (const k of Object.keys(before)) if (k in after && before[k] !== after[k]) d.push(`~ ${k}`);
  return d.sort();
}

// --- advisors (Management API; the MCP get_advisors tool reads the same lints) ---

async function lints(ref: string): Promise<Lint[]> {
  const all: Lint[] = [];
  for (const t of ["performance", "security"]) {
    const r = await mgmt("GET", `/projects/${ref}/advisors/${t}`);
    if (!r.ok) throw new Error(`advisors/${t} http ${r.status}`);
    all.push(...(((await r.json()) as { lints: Lint[] }).lints ?? []));
  }
  return all;
}

// --- logs (Management API analytics endpoint, ClickHouse SQL over the unified logs table) ---

async function logsQuery(ref: string, q: string, start: Date, end = new Date()): Promise<Record<string, unknown>[]> {
  const u = `/projects/${ref}/analytics/endpoints/logs?sql=${encodeURIComponent(q)}&iso_timestamp_start=${iso(start)}&iso_timestamp_end=${iso(end)}`;
  for (let attempt = 1; ; attempt++) {
    const r = await mgmt("GET", u);
    const body = (await r.json().catch(() => ({}))) as { result?: Record<string, unknown>[]; error?: unknown };
    // Errors come back as HTTP 200 with an `error` field; 429 on the rate limit.
    if (r.ok && !body.error) return body.result ?? [];
    if (attempt >= 4) throw new Error(`logs http ${r.status}: ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
    await Bun.sleep(20_000);
  }
}

const LOG_SQL = `
SELECT timestamp, source,
       log_attributes['request.method'] AS method,
       log_attributes['request.path'] AS path,
       log_attributes['response.status_code'] AS status,
       log_attributes['response.origin_time'] AS origin_ms,
       log_attributes['parsed.error_severity'] AS severity,
       log_attributes['parsed.sql_state_code'] AS sqlstate,
       log_attributes['parsed.query_id'] AS query_id,
       event_message
FROM logs
WHERE (source = 'edge_logs' AND log_attributes['request.path'] LIKE '%activity%')
   OR (source = 'postgres_logs' AND log_attributes['parsed.error_severity'] IN ('ERROR', 'FATAL')
       AND (event_message LIKE '%division by zero%' OR event_message LIKE '%statement timeout%'
            OR log_attributes['parsed.query'] LIKE '%activity%'))
ORDER BY timestamp DESC
LIMIT 200`;

// --- seeded users and the app path (Data API with the publishable key) ---

async function publishable(ref: string): Promise<string> {
  const r = await mgmt("GET", `/projects/${ref}/api-keys?reveal=true`);
  if (!r.ok) throw new Error(`api-keys http ${r.status}`);
  const k = ((await r.json()) as { type?: string; api_key?: string }[]).find((x) => x.type === "publishable")?.api_key;
  if (!k) throw new Error("no publishable key returned");
  return k;
}

function creds(ref: string): Record<string, string> {
  const f = `evidence/users-${ref}.json`;
  if (!existsSync(f)) throw new Error(`${f} missing - run make seed-ready`);
  return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
}

async function signIn(ref: string, pub: string, email: string, password: string): Promise<{ jwt: string; sub: string }> {
  const r = await fetch(`https://${ref}.supabase.co/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in as ${email}: http ${r.status}`);
  const j = (await r.json()) as { access_token: string; user: { id: string } };
  return { jwt: j.access_token, sub: j.user.id };
}

async function timed(url: string, init: RequestInit): Promise<{ status: number; ms: number; body: string }> {
  const t0 = performance.now();
  const r = await fetch(url, init);
  const body = await r.text();
  return { status: r.status, ms: Math.round(performance.now() - t0), body };
}

// --- commands ---

function sections(): Record<string, string> {
  const text = readFileSync("sql/40-faults.sql", "utf8");
  const out: Record<string, string> = {};
  for (const part of text.split(/^-- fault: /m).slice(1)) {
    const nl = part.indexOf("\n");
    out[part.slice(0, nl).trim()] = part.slice(nl + 1);
  }
  return out;
}

async function present(ref: string): Promise<{ table: boolean; fn: boolean }> {
  const r = await sql<{ t: string | null; f: string | null }>(
    ref,
    "select to_regclass('public.activity_events')::text as t, to_regprocedure('public.activity_summary()')::text as f",
  );
  return { table: Boolean(r[0]?.t), fn: Boolean(r[0]?.f) };
}

async function inject(ref: string, which: string): Promise<void> {
  const wanted: Fault[] = which === "all" ? [...FAULTS] : [which as Fault];
  if (!wanted.every((f) => FAULTS.includes(f))) throw new Error(`unknown fault ${which}; one of ${FAULTS.join(", ")}, all`);
  const order = FAULTS.filter((f) => wanted.includes(f) || wanted.some((w) => NEEDS[w].includes(f)));

  let state = readState(ref);
  if (!state) {
    const p = await present(ref);
    if (p.table || p.fn) throw new Error("fault objects exist but no state file - run clear first");
    state = {
      injectedAt: new Date().toISOString(),
      faults: [],
      inventory: await inventory(ref),
      lints: (await lints(ref)).map((l) => l.cache_key),
    };
    mkdirSync("evidence", { recursive: true });
    writeFileSync(statePath(ref), JSON.stringify(state, null, 2));
    console.log(`snapshot: ${Object.keys(state.inventory).length} objects, ${state.lints.length} advisor findings`);
  }
  const sec = sections();
  for (const f of order) {
    if (state.faults.includes(f)) {
      console.log(`${f}: already injected`);
      continue;
    }
    const t0 = performance.now();
    await sql(ref, sec[f]);
    state.faults.push(f);
    writeFileSync(statePath(ref), JSON.stringify(state, null, 2));
    console.log(`${f}: injected (${Math.round(performance.now() - t0)} ms)`);
  }
  // The seeding statements would top Query Performance; drop their entries so
  // the page shows only app traffic.
  const n = await resetStatements(ref);
  console.log(`pg_stat_statements: ${n} setup entries reset`);
}

// Reset the pg_stat_statements entries on the fault objects; `only` narrows it
// to statements matching a further pattern (the timing harness's own SQL).
async function resetStatements(ref: string, only = ""): Promise<number> {
  const r = await sql<{ n: number }>(
    ref,
    `select count(extensions.pg_stat_statements_reset(0, 0, queryid))::int as n
       from extensions.pg_stat_statements
      where queryid <> 0 and query ~* '${FAULT_RE}' ${only ? `and query ~* '${only}'` : ""}`,
  );
  return r[0]?.n ?? 0;
}

async function traffic(ref: string, rounds: number): Promise<void> {
  const pub = await publishable(ref);
  const c = creds(ref);
  const users = ["alice@example.com", "bob@example.com"].filter((e) => c[e]);
  for (const email of users) {
    const { jwt } = await signIn(ref, pub, email, c[email]);
    const h = { apikey: pub, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
    const feed: string[] = [];
    const rpc: string[] = [];
    for (let i = 0; i < rounds; i++) {
      const a = await timed(`https://${ref}.supabase.co${FEED}`, { headers: h });
      feed.push(`${a.status}/${a.ms}ms`);
      const b = await timed(`https://${ref}.supabase.co${SUMMARY}`, { method: "POST", headers: h, body: "{}" });
      rpc.push(b.status === 200 ? `${b.status}/${b.ms}ms` : `${b.status}/${b.ms}ms ${b.body.slice(0, 90)}`);
    }
    console.log(`${email.split("@")[0]} feed:    ${feed.join("  ")}`);
    console.log(`${email.split("@")[0]} summary: ${rpc.join("  ")}`);
  }
}

async function check(ref: string, wait: boolean): Promise<void> {
  const state = readState(ref);
  const p = await present(ref);
  const faulty = Boolean(state && state.faults.length > 0);
  console.log(`== state: ${faulty ? `faults ${state?.faults.join(", ")} since ${state?.injectedAt}` : "no faults recorded"}`);
  console.log(`objects: activity_events ${p.table ? "present" : "absent"}, activity_summary() ${p.fn ? "present" : "absent"}`);
  const report: Record<string, unknown> = { at: new Date().toISOString(), ref: "<ready>", faulty, present: p };

  // 1. Advisors
  const all = await lints(ref);
  const hits = all.filter((l) => new RegExp(FAULT_RE).test(`${l.detail} ${l.cache_key}`));
  console.log(`\n== advisors: ${all.length} findings, ${hits.length} on fault objects`);
  for (const l of hits) console.log(`  ${l.level} ${l.name}: ${l.detail}`);
  report.advisors = hits.map((l) => ({ name: l.name, level: l.level, detail: l.detail }));

  // 2. pg_stat_statements
  const stmts = await sql(
    ref,
    `select queryid::text, calls, round(mean_exec_time::numeric, 1) as mean_ms,
            round(max_exec_time::numeric, 1) as max_ms, rows,
            left(regexp_replace(query, '\\s+', ' ', 'g'), 140) as query
       from extensions.pg_stat_statements
      where query ~* '${FAULT_RE}' and query !~* 'pg_stat_statements'
      order by total_exec_time desc limit 8`,
  );
  console.log(`\n== pg_stat_statements: ${stmts.length} statements on fault objects`);
  for (const s of stmts) console.log(`  calls=${s.calls} mean=${s.mean_ms}ms max=${s.max_ms}ms queryid=${s.queryid}\n    ${s.query}`);
  report.statements = stmts;

  // 3. Logs, in the window since the inject (or the last 15 min when clean).
  const clearedFile = `evidence/faults-${ref}.last-clear`;
  const lastClear = existsSync(clearedFile) ? new Date(readFileSync(clearedFile, "utf8").trim()) : new Date(0);
  const since =
    faulty && state
      ? new Date(state.injectedAt)
      : new Date(Math.max(lastClear.getTime(), Date.now() - 60 * 60_000));
  let rows: Record<string, unknown>[] = [];
  const deadline = Date.now() + (wait && faulty ? 6 * 60_000 : 0);
  for (;;) {
    rows = await logsQuery(ref, LOG_SQL, since);
    const edge = rows.some((r) => r.source === "edge_logs");
    const pg = rows.some((r) => r.source === "postgres_logs");
    if (!faulty || (edge && pg) || Date.now() > deadline) break;
    console.log(`  logs: edge ${edge ? "seen" : "not yet"}, postgres ${pg ? "seen" : "not yet"} - waiting for ingestion`);
    await Bun.sleep(30_000);
  }
  const edge = rows.filter((r) => r.source === "edge_logs");
  const pg = rows.filter((r) => r.source === "postgres_logs");
  console.log(`\n== logs since ${iso(since)}: ${edge.length} edge_logs, ${pg.length} postgres_logs`);
  const groups = new Map<string, number[]>();
  for (const r of edge) {
    const k = `${r.method} ${r.path} ${r.status}`;
    groups.set(k, [...(groups.get(k) ?? []), Number(r.origin_ms)]);
  }
  for (const [k, v] of groups) {
    const s = [...v].sort((a, b) => a - b);
    console.log(`  edge ${k}: n=${v.length} origin_time p50=${s[Math.floor(s.length / 2)]}ms max=${s[s.length - 1]}ms`);
  }
  const errs = new Map<string, number>();
  for (const r of pg) {
    const k = `${r.severity} ${r.sqlstate} "${r.event_message}" query_id=${r.query_id}`;
    errs.set(k, (errs.get(k) ?? 0) + 1);
  }
  for (const [k, n] of errs) console.log(`  postgres ${k}: n=${n}`);
  // The postgres log line carries the pg_stat_statements queryid: join them.
  const qids = [...new Set(pg.map((r) => String(r.query_id)).filter((q) => /^-?\d+$/.test(q) && q !== "0"))];
  if (qids.length > 0) {
    const j = await sql(
      ref,
      `select queryid::text, calls, left(regexp_replace(query, '\\s+', ' ', 'g'), 100) as query
         from extensions.pg_stat_statements where queryid in (${qids.join(", ")})`,
    );
    for (const r of j) console.log(`  query_id ${r.queryid} -> pg_stat_statements calls=${r.calls}: ${r.query}`);
    report.join = j;
  }
  report.logs = { since: iso(since), edge: Object.fromEntries(groups), postgres: Object.fromEntries(errs) };

  mkdirSync("evidence/faults", { recursive: true });
  const out = `evidence/faults/check-${iso(new Date()).replace(/[:]/g, "")}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nwritten ${out}`);

  if (!faulty) {
    const dirty = p.table || p.fn || hits.length > 0 || stmts.length > 0 || rows.length > 0;
    console.log(dirty ? "CLEAN CHECK FAILED" : "clean: no fault objects, advisor findings, statements or log lines");
    if (dirty) process.exitCode = 1;
  }
}

// EXPLAIN ANALYZE as each seeded user, as injected and with the fix applied in
// the same transaction - lib/pg.ts asUser always rolls back, so the fix is
// never kept. The fix is what docs/OBSERVABILITY.md calls a good answer.
const FIX = `
reset role;
create index on public.activity_events (created_at desc);
create index on public.activity_events (actor_id);
create index on public.activity_events (department_id);
drop policy "activity: own or manager of department" on public.activity_events;
create policy "activity: own or manager of department" on public.activity_events
  for select to authenticated
  using (actor_id = (select auth.uid())
         or ((select private.is_manager()) and department_id = (select private.my_department())));
analyze public.activity_events;
set local role authenticated;`;
const EXPLAIN =
  "explain (analyze, buffers) select id, kind, created_at, actor_id from public.activity_events order by created_at desc limit 50";

async function timing(ref: string): Promise<void> {
  const pw = process.env.DB_PASSWORD ?? "";
  const host = process.env.POOLER_HOST ?? "";
  if (!pw || !host) throw new Error("timing needs DB_PASSWORD and POOLER_HOST");
  const ctx = { ref, dbPassword: pw, endpoints: { pooler: host } } as unknown as Ctx;
  const ids = await sql<{ email: string; id: string }>(
    ref,
    "select u.email, u.id::text from auth.users u where u.email in ('alice@example.com', 'bob@example.com') order by 1",
  );
  for (const u of ids) {
    for (const [label, pre] of [
      ["as injected", ""],
      ["with fix  ", FIX],
    ] as const) {
      const runs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const o = await asUser(ctx, u.id, `${pre} ${EXPLAIN}`);
        runs.push(o.ok ? o.value.replace("Execution Time: ", "") : `ERR ${o.value.slice(0, 120)}`);
      }
      console.log(`${u.email.split("@")[0].padEnd(5)} ${label}: ${runs.join(", ")}`);
    }
  }
  // Keep Query Performance about the app's traffic, not this harness.
  await resetStatements(ref, "^\\s*(explain|analyze|create index|drop policy|create policy|reset role)");
}

async function clear(ref: string): Promise<void> {
  const state = readState(ref);
  const hasMig = await migrationsTable(ref);
  // Migration rows that name the fault objects and were not in the snapshot:
  // a coding agent's fix, applied through MCP apply_migration.
  const migDelete =
    hasMig && state
      ? `delete from supabase_migrations.schema_migrations
          where statements::text ~* '${FAULT_RE}'
            and version not in (${
              Object.keys(state.inventory)
                .filter((k) => k.startsWith("migration "))
                .map((k) => `'${k.slice(10).replaceAll("'", "''")}'`)
                .join(", ") || "''"
            });`
      : "";
  await sql(
    ref,
    `drop function if exists public.activity_summary() cascade;
     drop table if exists public.activity_events cascade;
     ${migDelete}`,
  );
  console.log("dropped activity_summary(), activity_events (cascade)");
  console.log(`pg_stat_statements: ${await resetStatements(ref)} fault entries reset`);
  if (!state) {
    console.log("no state file - nothing to compare against");
    return;
  }
  const d = diff(state.inventory, await inventory(ref));
  // Only findings on the fault objects count: unrelated ones (unused_index
  // and the like) come and go with index-usage statistics between snapshots.
  const newLints = (await lints(ref)).filter((l) => !state.lints.includes(l.cache_key));
  const extra = newLints.filter((l) => new RegExp(FAULT_RE).test(`${l.detail} ${l.cache_key}`));
  for (const l of newLints.filter((x) => !extra.includes(x))) console.log(`advisors (unrelated, not counted): ${l.name}: ${l.detail}`);
  if (d.length === 0) console.log(`inventory: identical to the pre-inject snapshot (${Object.keys(state.inventory).length} objects)`);
  else console.log(`inventory DIFFERS from the snapshot:\n  ${d.join("\n  ")}`);
  if (extra.length === 0) console.log("advisors: no findings on fault objects");
  else console.log(`advisors: ${extra.length} new findings:\n  ${extra.map((l) => `${l.name}: ${l.detail}`).join("\n  ")}`);
  if (d.length > 0 || extra.length > 0) {
    console.log("state file kept - resolve the differences above, then run clear again");
    process.exitCode = 1;
    return;
  }
  renameSync(statePath(ref), statePath(ref).replace(/\.json$/, `.cleared-${Date.now()}.json`));
  writeFileSync(`evidence/faults-${ref}.last-clear`, new Date().toISOString());
  console.log(`cleared at ${iso(new Date())}; the clean check reads logs from here on`);
}

const [cmd, ref, arg] = process.argv.slice(2);
if (!ref) throw new Error("usage: faults.ts <inject|traffic|check|timing|clear> <ref> [...]");
if (process.env.KIT_LIVE_REF && process.env.KIT_LIVE_REF === ref) throw new Error("refusing to inject faults into the live project");
if (cmd === "inject") await inject(ref, arg ?? "all");
else if (cmd === "traffic") await traffic(ref, Number(arg ?? 5));
else if (cmd === "check") await check(ref, process.argv.includes("--wait"));
else if (cmd === "timing") await timing(ref);
else if (cmd === "clear") await clear(ref);
else throw new Error(`unknown command ${cmd}`);
