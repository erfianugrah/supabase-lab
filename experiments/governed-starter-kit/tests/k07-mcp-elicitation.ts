/**
 * K07 - Supabase MCP server confirmations (elicitations): what a client sees
 * when an agent runs destructive SQL or creates a paid branch, from clients
 * that declare elicitation support and clients that do not, and what
 * `skip_elicitations` changes.
 *
 * Self-provisioning, like K06: a throwaway project (prefix PVLAB_PROJECT_PREFIX,
 * default kit-mcp-) with one scratch table; the module refuses to run
 * statements against a project whose name lacks the prefix. The project is
 * deleted at the end, with any branch the run created. PVLAB_PEER_MCP=<ref>
 * adopts an existing prefixed project (kept).
 *
 * The hosted server (https://mcp.supabase.com/mcp, PAT as a Bearer header) is
 * driven by lib/mcp-client.ts in two protocol shapes:
 *  - legacy (a 2025 revision): initialize, session id, capabilities once;
 *  - 2026-07-28: stateless, capabilities in each request's `_meta`,
 *    elicitation as `resultType: "input_required"` answered by a repeat call.
 * Each is run with no elicitation capability, with form elicitation answering
 * accept / decline / cancel, and (2026-07-28) with URL elicitation only.
 *
 * Optional (PVLAB_K_CLAUDE=1, `claude` on PATH): Claude Code itself, with an
 * Elicitation hook that answers accept or decline (scripts/k07-elicit-hook.sh),
 * on the same statements.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { api, prefix, provision, sql, teardown, type Scratch } from "../lib/scratch-project";
import { McpClient, STATELESS, toolText, type ElicitReply, type McpCallResult } from "../lib/mcp-client";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MCP = "https://mcp.supabase.com/mcp";
const TITLE = "Supabase MCP elicitations: destructive SQL and paid branches, by client capability, skip_elicitations";

type Kind = "legacy-nocap" | "legacy-form" | "s-nocap" | "s-form" | "s-urlonly";
type Action = "accept" | "decline" | "cancel";

const KIND_LABEL: Record<Kind, string> = {
  "legacy-nocap": "L0",
  "legacy-form": "L1",
  "s-nocap": "S0",
  "s-form": "S1",
  "s-urlonly": "SU",
};

const STMT = {
  drop: "drop table public.k07_t",
  drop_upper: "DROP TABLE public.k07_t",
  truncate: "truncate public.k07_t",
  update_nowhere: "update public.k07_t set v = 'x'",
  delete_nowhere: "delete from public.k07_t",
  update_where: "update public.k07_t set v = 'x' where id = 1",
  update_where_true: "update public.k07_t set v = 'x' where true",
  delete_where_true: "delete from public.k07_t where true",
  select: "select count(*) from public.k07_t",
  insert: "insert into public.k07_t values (4, 'd')",
  drop_column: "alter table public.k07_t drop column v",
  drop_in_do: "do $$ begin execute 'drop table public.k07_t'; end $$",
  drop_in_literal: "select 'drop table public.k07_t' as s",
  multi: "select 1; drop table public.k07_t",
} as const;
type StmtKey = keyof typeof STMT;
const CORE: StmtKey[] = ["drop", "truncate", "update_nowhere", "delete_nowhere"];

// The state string of a freshly reset scratch table, read once; "applied" below
// means the statement left the table in some other state.
let INITIAL = "";

function mk(id: string, title: string, ok: boolean | "info", detail?: string, measurements?: Record<string, number | string>): TestResult {
  return { id, title, status: ok === "info" ? "info" : ok ? "pass" : "fail", ...(detail ? { detail } : {}), ...(measurements ? { measurements } : {}) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(kind: Kind, action: Action, query: string, pat: string, seen: { messages: string[]; keys: string[] }): McpClient {
  const stateless = kind.startsWith("s-");
  const caps: Record<string, unknown> =
    kind === "legacy-nocap" || kind === "s-nocap" ? {} : kind === "s-urlonly" ? { elicitation: { url: {} } } : { elicitation: { form: {} } };
  return new McpClient({
    url: `${MCP}?${query}`,
    headers: { Authorization: `Bearer ${pat}` },
    capabilities: caps,
    protocolVersion: stateless ? STATELESS : "2025-11-25",
    name: `k07-${KIND_LABEL[kind]}-${action}`,
    onServerRequest: (r): ElicitReply => {
      seen.messages.push(String(r.params.message ?? ""));
      seen.keys.push(r.key);
      return action === "accept" ? { action: "accept", content: {} } : { action };
    },
  });
}

interface Observed {
  elicits: number;
  status: string; // structuredContent.status, "error", or "ok"
  detail: string;
  applied: boolean;
  state: string;
}

async function stateOf(ctx: Ctx, ref: string): Promise<string> {
  const q = `select coalesce(to_regclass('public.k07_t')::text, 'gone') || '|' ||
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'k07_t') || '|' ||
    coalesce(case when to_regclass('public.k07_t') is null then null else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.k07_t', false, true, '')))[1]::text end, '-') || '|' ||
    coalesce(case when to_regclass('public.k07_t') is null then null else (xpath('/row/c/text()', query_to_xml($q$select string_agg(coalesce(to_jsonb(t)->>'v', '-'), ',' order by id) as c from public.k07_t t$q$, false, true, '')))[1]::text end, '-') || '|' ||
    case when to_regclass('supabase_migrations.schema_migrations') is null then '0' else (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from supabase_migrations.schema_migrations where name like 'k07%'$q$, false, true, '')))[1]::text end as s`;
  const rows = (await sql(ctx, ref, q)) as { s?: string }[];
  return rows[0]?.s ?? "?";
}

async function reset(ctx: Ctx, ref: string): Promise<void> {
  await sql(
    ctx,
    ref,
    `drop table if exists public.k07_t; drop table if exists public.k07_m;
     create table public.k07_t (id int primary key, v text);
     insert into public.k07_t values (1, 'a'), (2, 'b'), (3, 'c');
     do $$ begin if to_regclass('supabase_migrations.schema_migrations') is not null then delete from supabase_migrations.schema_migrations where name like 'k07%'; end if; end $$;`,
  );
  if (!INITIAL) INITIAL = await stateOf(ctx, ref);
}

function summarise(r: McpCallResult): { status: string; detail: string } {
  const st = (r.result?.structuredContent as { status?: string } | undefined)?.status;
  if (r.error) return { status: "rpc-error", detail: `${r.error.code ?? ""} ${r.error.message ?? ""}`.trim().slice(0, 160) };
  if (r.result?.isError === true) return { status: "error", detail: toolText(r).replace(/\s+/g, " ").slice(0, 200) };
  const rt = String((r.result as { resultType?: string } | undefined)?.resultType ?? "");
  return { status: st ?? (rt && rt !== "complete" ? rt : "ok"), detail: st ? toolText(r).slice(0, 80) : "" };
}

async function probe(ctx: Ctx, s: Scratch, c: McpClient, seen: { messages: string[] }, tool: string, args: Record<string, unknown>): Promise<Observed> {
  await reset(ctx, s.ref);
  const before = seen.messages.length;
  const init = await c.initialize();
  if (init.http >= 300 || init.error) return { elicits: 0, status: `init-http-${init.http}`, detail: init.error?.message ?? "", applied: false, state: "" };
  const r = await c.callTool(tool, args);
  const state = await stateOf(ctx, s.ref);
  const sm = summarise(r);
  return { elicits: seen.messages.length - before, status: sm.status, detail: sm.detail, applied: state !== INITIAL, state };
}

const fmt = (o: Observed): string => `elicit=${o.elicits} status=${o.status} applied=${o.applied ? 1 : 0}`;

async function listBranches(ctx: Ctx, ref: string): Promise<{ id: string; name: string; project_ref: string; is_default: boolean; status?: string }[]> {
  const r = await api(ctx, "GET", `/projects/${ref}/branches`);
  return (Array.isArray(r.json) ? r.json : []) as { id: string; name: string; project_ref: string; is_default: boolean; status?: string }[];
}

/** Branches other than the default one; a never-branched project lists none, and the first create adds a default `main` row too. */
async function extraBranches(ctx: Ctx, ref: string): Promise<number> {
  return (await listBranches(ctx, ref)).filter((b) => !b.is_default).length;
}

async function deleteBranches(ctx: Ctx, ref: string, log: string[]): Promise<number> {
  let n = 0;
  for (const b of await listBranches(ctx, ref)) {
    if (b.is_default) continue;
    if (!b.name.startsWith(prefix())) {
      log.push(`left branch ${b.name} (no prefix)`);
      continue;
    }
    const d = await api(ctx, "DELETE", `/branches/${b.id}`);
    log.push(`deleted branch ${b.name}: http ${d.status}`);
    n++;
  }
  return n;
}

function decodeState(state: string): Record<string, unknown> {
  try {
    const payload = state.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const mod: TestModule = {
  id: "K07",
  title: TITLE,
  where: "local",
  requires: ["pat"],
  destructive: true, // runs DROP/TRUNCATE on, and provisions and deletes, its own project
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.team) return [{ id: "K07", title: TITLE, status: "skip", detail: "PVLAB_ORG_TEAM not set" }];
    if (!ctx.pat) return [{ id: "K07", title: TITLE, status: "skip", detail: "no PAT" }];
    const pat = ctx.pat;
    const results: TestResult[] = [];
    let s: Scratch | undefined;
    const cleanup: string[] = [];
    try {
      s = await provision(ctx, "elicit", [], () => "", false);
      const ref = s.ref;
      const scoped = `project_ref=${ref}&features=database,branching`;
      const seen = { messages: [] as string[], keys: [] as string[] };
      await reset(ctx, ref);

      // K07.01 setup: server identity and the tool surface each client kind gets
      const surface: Record<string, number | string> = {};
      for (const kind of ["legacy-nocap", "legacy-form", "s-nocap", "s-form", "s-urlonly"] as Kind[]) {
        const c = client(kind, "decline", "read_only=false", pat, seen);
        const init = await c.initialize();
        const tools = ((await c.listTools()).result?.tools ?? []) as { name: string }[];
        surface[`${KIND_LABEL[kind]}_tools`] = tools.length;
        surface[`${KIND_LABEL[kind]}_has_get_cost`] = tools.some((t) => t.name === "get_cost") ? 1 : 0;
        surface[`${KIND_LABEL[kind]}_protocol`] = c.protocolVersion;
        if (kind === "s-form") surface.server = `${String(c.serverInfo.name ?? "")} ${String(c.serverInfo.version ?? "")}`.trim() || `http ${init.http}`;
      }
      results.push(mk("K07.01", "setup: tool surface per client kind (account-scoped connection)", "info", undefined, surface));

      // K07.02 detection matrix with a client that accepts every confirmation
      {
        const m: Record<string, number | string> = {};
        const first: string[] = [];
        const c = client("s-form", "accept", scoped, pat, seen);
        for (const k of Object.keys(STMT) as StmtKey[]) {
          const o = await probe(ctx, s, c, seen, "execute_sql", { query: STMT[k] });
          m[k] = fmt(o);
          if (o.elicits && !first.length) first.push(seen.messages[seen.messages.length - 1] ?? "");
          await sleep(1500);
        }
        const elicited = (k: StmtKey) => String(m[k]).startsWith("elicit=1");
        results.push(
          mk(
            "K07.02",
            "S1 (2026-07-28, form elicitation, accepts): execute_sql statements that raise a confirmation",
            CORE.every(elicited) && !elicited("select") && !elicited("insert") && !elicited("update_where"),
            first[0] ? `message: ${first[0].replace(/\n/g, " / ")}` : undefined,
            m,
          ),
        );
      }

      // K07.03 / K07.04 decline and cancel
      for (const action of ["decline", "cancel"] as Action[]) {
        const m: Record<string, number | string> = {};
        const c = client("s-form", action, scoped, pat, seen);
        for (const k of CORE) {
          m[k] = fmt(await probe(ctx, s, c, seen, "execute_sql", { query: STMT[k] }));
          await sleep(1500);
        }
        m.apply_migration_drop = fmt(await probe(ctx, s, c, seen, "apply_migration", { name: "k07_drop", query: STMT.drop }));
        const ok = Object.values(m).every((v) => String(v).startsWith("elicit=1") && String(v).endsWith("applied=0"));
        results.push(mk(action === "decline" ? "K07.03" : "K07.04", `S1 ${action}s: destructive statements are not run`, ok, undefined, m));
      }

      // K07.05 clients that do not declare form elicitation
      {
        const m: Record<string, number | string> = {};
        for (const kind of ["legacy-nocap", "legacy-form", "s-nocap", "s-urlonly"] as Kind[]) {
          const c = client(kind, "decline", scoped, pat, seen); // would decline, if ever asked
          for (const k of CORE) {
            m[`${KIND_LABEL[kind]}.${k}`] = fmt(await probe(ctx, s, c, seen, "execute_sql", { query: STMT[k] }));
            await sleep(1200);
          }
          m[`${KIND_LABEL[kind]}.apply_migration_drop`] = fmt(await probe(ctx, s, c, seen, "apply_migration", { name: "k07_drop", query: STMT.drop }));
        }
        // doc claim: without a form-capable client the SQL follows its existing path (runs)
        const ok = Object.values(m).every((v) => String(v).startsWith("elicit=0") && String(v).endsWith("applied=1"));
        results.push(mk("K07.05", "L0 L1 S0 SU (no form elicitation in the request): destructive statements run with no confirmation", ok, undefined, m));
      }

      // K07.06 apply_migration under an accepting client
      {
        const m: Record<string, number | string> = {};
        const c = client("s-form", "accept", scoped, pat, seen);
        m.drop = fmt(await probe(ctx, s, c, seen, "apply_migration", { name: "k07_drop", query: STMT.drop }));
        m.drop_migration_rows = (await stateOf(ctx, ref)).split("|")[4] ?? "?";
        m.truncate = fmt(await probe(ctx, s, c, seen, "apply_migration", { name: "k07_trunc", query: STMT.truncate }));
        m.create_control = fmt(await probe(ctx, s, c, seen, "apply_migration", { name: "k07_create", query: "create table public.k07_m (id int)" }));
        results.push(mk("K07.06", "S1 accepts: apply_migration with DROP and TRUNCATE confirms, a CREATE does not", String(m.drop).startsWith("elicit=1") && String(m.create_control).startsWith("elicit=0"), undefined, m));
      }

      // K07.07 skip_elicitations
      {
        const m: Record<string, number | string> = {};
        const run = async (label: string, query: string, tool: string, k: StmtKey) => {
          const c = client("s-form", "decline", query, pat, seen);
          const o = await probe(ctx, s!, c, seen, tool, tool === "execute_sql" ? { query: STMT[k] } : { name: "k07_skip", query: STMT[k] });
          m[label] = fmt(o);
          if (o.status.startsWith("init-http")) m[`${label}_reply`] = o.detail.slice(0, 140) || "(no body text)";
          await sleep(1200);
        };
        const both = `${scoped}&skip_elicitations=execute_sql,apply_migration`;
        await run("skip_both.execute_sql_drop", both, "execute_sql", "drop");
        await run("skip_both.execute_sql_truncate", both, "execute_sql", "truncate");
        await run("skip_both.execute_sql_update_nowhere", both, "execute_sql", "update_nowhere");
        await run("skip_both.apply_migration_drop", both, "apply_migration", "drop");
        await run("skip_apply_only.execute_sql_drop", `${scoped}&skip_elicitations=apply_migration`, "execute_sql", "drop");
        await run("skip_apply_only.apply_migration_drop", `${scoped}&skip_elicitations=apply_migration`, "apply_migration", "drop");
        await run("skip_sql_only.apply_migration_drop", `${scoped}&skip_elicitations=execute_sql`, "apply_migration", "drop");
        await run("skip_wrong_case.execute_sql_drop", `${scoped}&skip_elicitations=Execute_SQL`, "execute_sql", "drop");
        await run("skip_all.execute_sql_drop", `${scoped}&skip_elicitations=all`, "execute_sql", "drop");
        await run("skip_bogus.execute_sql_drop", `${scoped}&skip_elicitations=bogus`, "execute_sql", "drop");
        await run("skip_two_params.execute_sql_drop", `${scoped}&skip_elicitations=apply_migration&skip_elicitations=execute_sql`, "execute_sql", "drop");
        const ok =
          String(m["skip_both.execute_sql_drop"]).startsWith("elicit=0") &&
          String(m["skip_both.execute_sql_drop"]).endsWith("applied=1") &&
          String(m["skip_apply_only.execute_sql_drop"]).startsWith("elicit=1") &&
          String(m["skip_sql_only.apply_migration_drop"]).startsWith("elicit=1");
        results.push(mk("K07.07", "skip_elicitations: per-tool, bypasses the confirmation for a form-capable client (decline handler never called)", ok, undefined, m));
      }

      // K07.08 read-only
      {
        const m: Record<string, number | string> = {};
        const c = client("s-form", "accept", `${scoped}&read_only=true`, pat, seen);
        const o = await probe(ctx, s, c, seen, "execute_sql", { query: STMT.drop });
        m.drop = fmt(o);
        m.detail = o.detail.slice(0, 120);
        results.push(mk("K07.08", "read_only=true: DROP is refused and no confirmation is raised", o.elicits === 0 && !o.applied, undefined, m));
      }

      // K07.09 requestState: what one confirmation covers
      {
        const m: Record<string, number | string> = {};
        const c = client("s-form", "accept", scoped, pat, seen);
        await c.initialize();
        await reset(ctx, ref);
        const A = "update public.k07_t set v = v || 'x'";
        const first = await c.callOnce("execute_sql", { query: A });
        const rs = (first.result as { resultType?: string; requestState?: string; inputRequests?: Record<string, unknown> } | undefined) ?? {};
        m.first_call_result_type = String(rs.resultType ?? "none");
        const payload = decodeState(String(rs.requestState ?? ""));
        const inner = (payload.p ?? {}) as Record<string, unknown>;
        m.state_payload_keys = Object.keys(payload).sort().join(",");
        m.state_bound_to = Object.keys(inner).sort().join(",");
        m.state_ttl_s = typeof payload.exp === "number" ? Math.round(payload.exp - Date.now() / 1000) : "n/a";
        const accept = { inputResponses: { confirm_destructive: { action: "accept" } }, requestState: rs.requestState };
        // tamper: the state issued for A, presented with a different (destructive) query
        const tamper = await c.callOnce("execute_sql", { query: STMT.drop }, accept);
        m.tamper_query_status = summarise(tamper).status + (tamper.result?.resultType ? `/${String(tamper.result.resultType)}` : "");
        m.tamper_dropped_table = (await stateOf(ctx, ref)).startsWith("gone") ? 1 : 0;
        await reset(ctx, ref);
        // answer once, then replay the same answer and state
        const r1 = await c.callOnce("execute_sql", { query: A }, accept);
        const after1 = (await stateOf(ctx, ref)).split("|")[3] ?? "?";
        const r2 = await c.callOnce("execute_sql", { query: A }, accept);
        const after2 = (await stateOf(ctx, ref)).split("|")[3] ?? "?";
        m.answer_once = `${summarise(r1).status} v=${after1}`;
        m.replay_same_state = `${summarise(r2).status} v=${after2}`;
        // an accept with no requestState at all
        await reset(ctx, ref);
        const bare = await c.callOnce("execute_sql", { query: A }, { inputResponses: { confirm_destructive: { action: "accept" } } });
        m.accept_without_state = `${summarise(bare).status} v=${(await stateOf(ctx, ref)).split("|")[3] ?? "?"}`;
        results.push(mk("K07.09", "S1: what one accepted confirmation covers (query binding, replay, answer without state)", "info", undefined, m));
      }

      // K07.10 create_branch (project-scoped connection)
      {
        const m: Record<string, number | string> = {};
        m.default_branch_rows_before_first_create = (await listBranches(ctx, ref)).filter((b) => b.is_default).length;
        const brName = () => `${prefix()}br-${Date.now().toString(36)}`;
        let costMessage = "";
        for (const [label, kind, action] of [
          ["S1_decline", "s-form", "decline"],
          ["S1_cancel", "s-form", "cancel"],
          ["S0", "s-nocap", "decline"],
          ["L0", "legacy-nocap", "decline"],
          ["L1", "legacy-form", "decline"],
          ["SU", "s-urlonly", "decline"],
        ] as [string, Kind, Action][]) {
          const c = client(kind, action, scoped, pat, seen);
          await c.initialize();
          const n0 = seen.messages.length;
          const b0 = (await extraBranches(ctx, ref));
          const r = await c.callTool("create_branch", { name: brName() });
          const sm = summarise(r);
          if (!costMessage && seen.messages.length > n0) costMessage = seen.messages[seen.messages.length - 1] ?? "";
          m[`${label}`] = `elicit=${seen.messages.length - n0} status=${sm.status} new_branches=${(await extraBranches(ctx, ref)) - b0}`;
          if (sm.status === "error") m[`${label}_text`] = sm.detail.slice(0, 110);
          await sleep(1500);
        }
        // accept: creates the branch; the run deletes it
        const t0 = Date.now();
        const c = client("s-form", "accept", scoped, pat, seen);
        await c.initialize();
        const n0 = seen.messages.length;
        const b0 = (await extraBranches(ctx, ref));
        const r = await c.callTool("create_branch", { name: brName() });
        m.S1_accept = `elicit=${seen.messages.length - n0} status=${summarise(r).status} new_branches=${(await extraBranches(ctx, ref)) - b0} call_ms=${Date.now() - t0}`;
        // skip_elicitations=create_branch on a form-capable client
        const sk = client("s-form", "decline", `${scoped}&skip_elicitations=create_branch`, pat, seen);
        await sk.initialize();
        const n1 = seen.messages.length;
        const b1 = (await extraBranches(ctx, ref));
        const rs = await sk.callTool("create_branch", { name: brName() });
        m.S1_skip_create_branch = `elicit=${seen.messages.length - n1} status=${summarise(rs).status} new_branches=${(await extraBranches(ctx, ref)) - b1}`;
        if (summarise(rs).status === "error") m.S1_skip_create_branch_text = summarise(rs).detail.slice(0, 110);
        m.default_branch_rows_after = (await listBranches(ctx, ref)).filter((b) => b.is_default).length;
        const created = await deleteBranches(ctx, ref, cleanup);
        m.branches_deleted = created;
        results.push(
          mk(
            "K07.10",
            "create_branch (project-scoped): cost confirmation by client kind; decline and cancel create nothing",
            String(m.S1_decline).includes("new_branches=0") && String(m.S1_cancel).includes("new_branches=0") && String(m.S1_accept).includes("new_branches=1"),
            costMessage ? `message: ${costMessage.replace(/\n/g, " / ")}` : undefined,
            m,
          ),
        );
      }

      // K07.13 other branch tools the docs do not list for confirmation: does a form-capable client that declines everything get asked?
      {
        const m: Record<string, number | string> = {};
        const mkc = client("s-form", "accept", scoped, pat, seen);
        await mkc.initialize();
        await mkc.callTool("create_branch", { name: `${prefix()}brz-${Date.now().toString(36)}` });
        let br = (await listBranches(ctx, ref)).find((b) => !b.is_default);
        for (let i = 0; i < 18 && br && !["FUNCTIONS_DEPLOYED", "MIGRATIONS_PASSED", "RUNNING_MIGRATIONS"].includes(String(br.status)); i++) {
          await sleep(5000);
          br = (await listBranches(ctx, ref)).find((b) => !b.is_default);
        }
        if (!br) {
          m.note = "no branch to test with";
        } else {
          const dc = client("s-form", "decline", scoped, pat, seen); // answers decline to anything it is asked
          await dc.initialize();
          for (const tool of ["reset_branch", "rebase_branch", "delete_branch"]) {
            const n0 = seen.messages.length;
            const r = await dc.callTool(tool, { branch_id: br.id });
            const sm = summarise(r);
            m[tool] = `elicit=${seen.messages.length - n0} status=${sm.status}`;
            if (sm.status === "error" || sm.status === "rpc-error") m[`${tool}_text`] = sm.detail.slice(0, 110);
            await sleep(1500);
          }
          m.branch_left_after = (await listBranches(ctx, ref)).filter((b) => !b.is_default).length;
        }
        await deleteBranches(ctx, ref, cleanup);
        results.push(mk("K07.13", "branch tools outside the documented confirmations (reset_branch, rebase_branch, delete_branch) under a form-capable client that declines every prompt", "info", undefined, m));
      }

      // K07.11 account-scoped create_branch for a client without elicitation: the legacy cost-confirmation tools
      {
        const m: Record<string, number | string> = {};
        const c = client("s-nocap", "decline", "read_only=false", pat, seen);
        await c.initialize();
        const orgs = await c.callTool("list_organizations", {});
        const orgText = toolText(orgs);
        const orgId = /"id"\s*:\s*"([^"]+)"/.exec(orgText)?.[1] ?? "";
        m.list_organizations_http = orgs.http;
        const useOrg = orgText.includes(ctx.orgs.team ?? "-") ? (ctx.orgs.team ?? orgId) : orgId;
        const quote = await c.callTool("get_cost", { type: "branch", organization_id: useOrg });
        m.get_cost = summarise(quote).status + " " + toolText(quote).replace(/\s+/g, " ").slice(0, 120);
        const q = /(\d+\.\d+)/.exec(toolText(quote));
        const conf = await c.callTool("confirm_cost", { type: "branch", recurrence: "hourly", amount: q ? Number(q[1]) : 0 });
        let confId = "";
        try {
          confId = String((JSON.parse(toolText(conf)) as { confirmation_id?: string }).confirmation_id ?? "");
        } catch {
          confId = "";
        }
        m.confirm_cost = `${summarise(conf).status} id_returned=${confId ? 1 : 0}`;
        const b0 = (await extraBranches(ctx, ref));
        const none = await c.callTool("create_branch", { project_id: ref, name: `${prefix()}brx-${Date.now().toString(36)}` });
        m.create_without_confirm_id = `${summarise(none).status} new_branches=${(await extraBranches(ctx, ref)) - b0}`;
        const b1 = (await extraBranches(ctx, ref));
        const withId = await c.callTool("create_branch", { project_id: ref, name: `${prefix()}bry-${Date.now().toString(36)}`, confirm_cost_id: confId });
        m.create_with_confirm_id = `${summarise(withId).status} new_branches=${(await extraBranches(ctx, ref)) - b1}`;
        if (summarise(withId).status === "error") m.create_with_confirm_id_text = summarise(withId).detail.slice(0, 120);
        await deleteBranches(ctx, ref, cleanup);
        results.push(mk("K07.11", "create_branch from a client with no elicitation (account-scoped): get_cost, confirm_cost, then create_branch with the id; no human step in this script", "info", undefined, m));
      }

      // K07.12 Claude Code with an Elicitation hook
      if (process.env.PVLAB_K_CLAUDE === "1") {
        results.push(...(await claudeRuns(ctx, s, pat)));
      } else {
        results.push(mk("K07.12", "Claude Code with an Elicitation hook", "info", "not run: set PVLAB_K_CLAUDE=1 (needs the claude CLI and a login)"));
      }
    } catch (e) {
      results.push(mk("K07.99", "aborted", false, (e as Error).message));
    } finally {
      if (s) {
        await deleteBranches(ctx, s.ref, cleanup).catch((e) => cleanup.push(`branch cleanup error: ${(e as Error).message}`));
      }
      const note = await teardown(ctx, s).catch((e) => `teardown error: ${(e as Error).message}`);
      cleanup.push(note);
      ctx.log(`cleanup: ${cleanup.join("; ")}`);
      results.push(mk("K07.teardown", "branches and project removed", "info", cleanup.join("; ")));
    }
    return results;
  },
};

async function claudeRuns(ctx: Ctx, s: Scratch, pat: string): Promise<TestResult[]> {
  const have = await $`claude --version`.quiet().nothrow();
  if (have.exitCode !== 0) return [mk("K07.12", "Claude Code with an Elicitation hook", "info", "claude CLI not found")];
  const jq = await $`jq --version`.quiet().nothrow();
  if (jq.exitCode !== 0) return [mk("K07.12", "Claude Code with an Elicitation hook", "info", "jq not found (scripts/k07-elicit-hook.sh needs it)")];
  const version = have.stdout.toString().trim();
  const dir = mkdtempSync(join(tmpdir(), "k07-cc-"));
  const hook = `${ROOT}scripts/k07-elicit-hook.sh`;
  const settings = join(dir, "hook-settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { Elicitation: [{ matcher: "supabase", hooks: [{ type: "command", command: hook }] }] } }));
  const mcpFor = (query: string): string => {
    const p = join(dir, `mcp-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ mcpServers: { supabase: { type: "http", url: `${MCP}?${query}`, headers: { Authorization: "Bearer ${SUPABASE_ACCESS_TOKEN}" } } } }));
    return p;
  };
  const scoped = `project_ref=${s.ref}&features=database,branching`;
  const prompt = (sqlText: string) =>
    `This is a throwaway test project. Call the supabase execute_sql tool once with exactly this query and report the tool's reply in one line: ${sqlText}`;
  interface Run {
    label: string;
    action: "accept" | "decline" | "none";
    query: string;
    task: { kind: "sql"; key: StmtKey } | { kind: "branch" };
  }
  const runs: Run[] = [
    { label: "drop.decline", action: "decline", query: scoped, task: { kind: "sql", key: "drop" } },
    { label: "drop.accept", action: "accept", query: scoped, task: { kind: "sql", key: "drop" } },
    { label: "drop.nohook_p", action: "none", query: scoped, task: { kind: "sql", key: "drop" } },
    { label: "truncate.decline", action: "decline", query: scoped, task: { kind: "sql", key: "truncate" } },
    { label: "truncate.accept", action: "accept", query: scoped, task: { kind: "sql", key: "truncate" } },
    { label: "update_nowhere.decline", action: "decline", query: scoped, task: { kind: "sql", key: "update_nowhere" } },
    { label: "update_nowhere.accept", action: "accept", query: scoped, task: { kind: "sql", key: "update_nowhere" } },
    { label: "drop.skip_both.decline", action: "decline", query: `${scoped}&skip_elicitations=execute_sql,apply_migration`, task: { kind: "sql", key: "drop" } },
    { label: "create_branch.decline", action: "decline", query: scoped, task: { kind: "branch" } },
    { label: "create_branch.accept", action: "accept", query: scoped, task: { kind: "branch" } },
  ];
  const m: Record<string, number | string> = { claude_code: version };
  for (const r of runs) {
    await reset(ctx, s.ref);
    const log = join(dir, `${r.label}.log`);
    writeFileSync(log, "");
    const text =
      r.task.kind === "sql"
        ? prompt(STMT[r.task.key])
        : `This is a throwaway test project. Call the supabase create_branch tool once with name "${prefix()}ccbr-${Date.now().toString(36)}" and report the tool's reply in one line.`;
    const args = [
      "-p", text,
      "--setting-sources", "project,local",
      ...(r.action === "none" ? [] : ["--settings", settings]),
      "--strict-mcp-config", "--mcp-config", mcpFor(r.query),
      "--allowedTools", "mcp__supabase__*",
      "--permission-mode", "dontAsk",
      "--output-format", "json",
      "--model", "haiku",
    ];
    const before = (await extraBranches(ctx, s.ref));
    const p = await $`claude ${args}`
      .cwd(dir)
      .env({ ...process.env, SUPABASE_ACCESS_TOKEN: pat, K07_ACTION: r.action === "accept" ? "accept" : "decline", K07_LOG: log })
      .quiet()
      .nothrow();
    let reply = "";
    try {
      reply = String((JSON.parse(p.stdout.toString()) as { result?: string }).result ?? "").replace(/\s+/g, " ").slice(0, 100);
    } catch {
      reply = `exit ${p.exitCode}`;
    }
    const events = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    const state = await stateOf(ctx, s.ref);
    const branches = (await extraBranches(ctx, s.ref)) - before;
    m[r.label] = `hook_events=${events} applied=${state !== INITIAL ? 1 : 0} branches=${branches} reply="${reply}"`;
    if (branches > 0) await deleteBranches(ctx, s.ref, []);
    await sleep(2000);
  }
  return [mk("K07.12", "Claude Code (-p, Elicitation hook answers accept or decline): same statements and create_branch", "info", undefined, m)];
}

export default mod;
