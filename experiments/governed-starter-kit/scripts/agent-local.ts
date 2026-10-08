/**
 * Local run of the in-app agent's chat loop (the K03 checks) on a throwaway
 * local Supabase stack in Docker. Nothing hosted is touched.
 *
 *   bun scripts/agent-local.ts <env-file>          start, check, stop  (make agent-local ENV_FILE=...)
 *   KEEP=1 bun scripts/agent-local.ts <env-file>   leave the stack running afterwards
 *
 * <env-file> is required and holds ANTHROPIC_API_KEY. This script never reads
 * it: the path goes only to `supabase functions serve --env-file`, which puts
 * the values into the local edge-runtime container's environment. Without
 * the key in it, chat answers 503 llm_not_configured and K03 reports skip.
 *
 * Env: AGENT_LOCAL_DIR (default $TMPDIR/kit-agent-local).
 *
 * What it does (stack helpers in lib/local-stack.ts): `supabase init` in
 * AGENT_LOCAL_DIR with ports shifted to 5452x and project id kit-agent-local
 * (so it runs beside bff-local on 5442x or a default stack on 5432x), a
 * minimal `supabase start` (db, auth, rest, kong), sql/00-baseline.sql,
 * 10-app.sql and 20-agent.sql through psql (30-integrations is skipped: the
 * agent does not depend on it, its decision webhook needs pg_net, Vault
 * entries and the webhook-sink function, and K04 covers it), the kit seed from
 * lib/seed.ts (departments; alice, bob, carol, dave through the Auth admin
 * API with generated passwords kept in evidence/users-agent-local.json,
 * gitignored and never printed; example requests and KB rows), then
 * `supabase functions serve` for `agent` only, real gte-small embeddings for
 * the KB rows through the function's embed mode, a few tool-mode checks that
 * need no model (T01-T06), and the K03 chat checks from
 * lib/agent-chat-checks.ts. Results go to evidence/agent-local-<ts>.json
 * (gitignored). Only pass/fail lines and non-secret measurements are printed.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentCheck, agentCall, agentChatChecks, lit, type Session, type Who } from "../lib/agent-chat-checks";
import { applySql, createUser, KIT, owner, prepareDir, serveFunctions, type StackSpec, startStack, type Status, stopStack } from "../lib/local-stack";
import { DEPARTMENTS_SQL, KB_SQL, kbText, newPassword, REQUESTS_SQL, USERS } from "../lib/seed";

const arg = process.argv[2] ?? "";
if (!arg) {
  console.error("usage: bun scripts/agent-local.ts <env-file>   (make agent-local ENV_FILE=<path>)\nThe env file must hold ANTHROPIC_API_KEY; it is passed to `supabase functions serve --env-file` and never read here.");
  process.exit(64);
}
const ENV_FILE = resolve(arg);
if (!existsSync(ENV_FILE) || !statSync(ENV_FILE).isFile()) {
  console.error(`ENV_FILE is not a file: ${ENV_FILE}`);
  process.exit(66);
}

const SPEC: StackSpec = {
  dir: process.env.AGENT_LOCAL_DIR ?? join(tmpdir(), "kit-agent-local"),
  projectId: "kit-agent-local",
  portBlock: "545",
  functions: ["agent"],
};
const MARK = "agent-local probe";

interface ToolCheck extends AgentCheck {
  id: string;
}

const startedAt = new Date();
let serve: Bun.Subprocess | undefined;
let stopping = false;

async function teardown() {
  if (stopping) return;
  stopping = true;
  serve?.kill();
  await serve?.exited;
  if (!process.env.KEEP) {
    await stopStack(SPEC);
    console.log("local stack stopped (supabase stop --no-backup)");
  } else {
    // functions serve (the only process given the env file) has exited by now.
    console.log(`KEEP=1: db/auth/rest/kong left running (workdir ${SPEC.dir}); stop with \`supabase stop --workdir ${SPEC.dir} --no-backup\``);
  }
}
// Ctrl-C must not leave the edge runtime (and the key in its environment) running.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.error(`\n${sig}: stopping`);
    await teardown();
    process.exit(130);
  });
}

async function seed(st: Status): Promise<Record<Who | "dave", Session>> {
  const d = await owner(st, DEPARTMENTS_SQL);
  if (!d.ok) throw new Error(`departments: ${d.value.slice(0, 300)}`);
  const creds: Record<string, string> = {};
  const sessions = {} as Record<Who | "dave", Session>;
  for (const u of USERS) {
    const password = newPassword();
    const s = await createUser(st, u.email, password, {
      app_metadata: { department: u.department, role: u.role },
      user_metadata: { display_name: u.name },
    });
    creds[u.email] = password;
    sessions[u.email.split("@")[0] as Who | "dave"] = s;
  }
  mkdirSync(join(KIT, "evidence"), { recursive: true });
  writeFileSync(join(KIT, "evidence", "users-agent-local.json"), JSON.stringify(creds, null, 2), { mode: 0o600 });
  const profiles = await owner(st, "select count(*) from public.profiles");
  if (profiles.value !== String(USERS.length)) throw new Error(`expected ${USERS.length} profiles from the signup trigger, got ${profiles.value}`);
  for (const [name, q] of [["requests", REQUESTS_SQL], ["kb", KB_SQL]] as const) {
    const r = await owner(st, q);
    if (!r.ok) throw new Error(`seed ${name}: ${r.value.slice(0, 300)}`);
  }
  console.log(`seeded: ${USERS.length} users (passwords in evidence/users-agent-local.json), example requests, 8 KB rows`);
  return sessions;
}

async function waitReady(t: { functionsUrl: string; publishableKey: string }, jwt: string): Promise<{ ready_ms: number; first_ok_ms: number }> {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 180_000) throw new Error(`agent function not ready after 180 s - see ${join(SPEC.dir, "functions-serve.log")}`);
    try {
      const c = await agentCall(t, jwt, { mode: "tool", tool: "list_requests", input: { status: "any" } });
      if (c.status === 200 && c.body.status === "ok") return { ready_ms: Date.now() - t0, first_ok_ms: c.wall_ms };
    } catch {
      // gateway not routing to the runtime yet
    }
    await Bun.sleep(1000);
  }
}

/** Replace the seed's placeholder KB vectors with gte-small ones from embed mode (kit.ts embed, locally). */
async function embedKb(st: Status, t: { functionsUrl: string; publishableKey: string }, jwt: string): Promise<ToolCheck> {
  const rows = JSON.parse(
    (await owner(st, "select coalesce(json_agg(json_build_object('id', id, 'title', title, 'content', content) order by title), '[]') from public.kb_chunks")).value || "[]",
  ) as { id: string; title: string; content: string }[];
  const c = await agentCall(t, jwt, { mode: "embed", texts: rows.map((r) => kbText(r.title, r.content)) });
  const vectors = (c.body.vectors ?? []) as number[][];
  let updated = "0";
  if (c.status === 200 && vectors.length === rows.length) {
    const values = rows.map((r, j) => `(${lit(r.id)}::uuid, ${lit(JSON.stringify(vectors[j]))})`).join(", ");
    const u = await owner(st, `with u as (update public.kb_chunks k set embedding = v.e::extensions.vector from (values ${values}) as v(id, e) where k.id = v.id returning 1) select count(*) from u`);
    updated = u.ok ? u.value : `error: ${u.value.slice(0, 200)}`;
  }
  const ok = c.status === 200 && c.body.dims === 384 && updated === String(rows.length) && rows.length === 8;
  return {
    id: "E01",
    n: 0,
    title: "embed mode: gte-small vectors (384 dims) for the 8 seeded KB rows, written back as owner",
    status: ok ? "pass" : "fail",
    detail: `http ${c.status}, dims=${c.body.dims}, vectors=${vectors.length}, rows updated=${updated}`,
    evidence: c.status === 200 ? "" : JSON.stringify(c.body).slice(0, 400),
    measurements: { embed_8_ms: c.wall_ms },
  };
}

/** Deterministic tool-layer checks (no model): the same runTool() path the chat loop uses. */
async function toolChecks(st: Status, t: { functionsUrl: string; publishableKey: string }, s: Record<Who, Session>): Promise<ToolCheck[]> {
  const out: ToolCheck[] = [];
  const add = (id: string, title: string, pass: boolean, detail: string, evidence = "", wall?: number) =>
    out.push({ id, n: 0, title, status: pass ? "pass" : "fail", detail, evidence: evidence.slice(0, 600), measurements: wall === undefined ? undefined : { ms: wall } });
  const tool = (name: string, input: Record<string, unknown>, confirm = false) => ({ mode: "tool", tool: name, input, confirm });
  const markRows = () => owner(st, `select count(*) from public.purchase_requests where justification like ${lit(`${MARK}%`)}`);

  const anon = await agentCall(t, null, tool("list_requests", { status: "any" }));
  add("T01", "no JWT: refused at the gateway before the function runs", anon.status === 401, `http ${anon.status}`, "", anon.wall_ms);

  const input = { item: "Demo laptop", vendor: "Acme Hardware", amount: 1500, justification: `${MARK}: demo unit` };
  const proposed = await agentCall(t, s.alice.jwt, tool("create_request", input));
  const before = await markRows();
  add("T02", "alice: create_request without confirm returns a proposal, writes nothing", proposed.status === 200 && proposed.body.status === "confirm" && before.value === "0", `status=${proposed.body.status}, rows=${before.value}`, "", proposed.wall_ms);

  const t3 = (await owner(st, "select now()")).value;
  const created = await agentCall(t, s.alice.jwt, tool("create_request", input, true));
  const id = String((created.body.result as { id?: string } | undefined)?.id ?? "");
  const row = id
    ? await owner(st, `select r.requester_id = ${lit(s.alice.id)}::uuid and d.name = 'Sales' and r.status = 'pending' from public.purchase_requests r join public.departments d on d.id = r.department_id where r.id = ${lit(id)}::uuid`)
    : { ok: false, value: "no id returned" };
  const audit = await owner(st, `select count(*) from public.agent_audit where user_id = ${lit(s.alice.id)}::uuid and tool = 'create_request' and created_at >= ${lit(t3)}::timestamptz`);
  add("T03", "alice: confirmed create_request lands as alice / Sales / pending, one agent_audit row", created.body.status === "ok" && row.value === "t" && audit.value === "1", `status=${created.body.status}, owner check=${row.value}, audit rows=${audit.value}`, "", created.wall_ms);

  const self = await agentCall(t, s.alice.jwt, tool("decide_request", { request_id: id, decision: "approved", note: "" }, true));
  const still = await owner(st, `select status from public.purchase_requests where id = ${lit(id)}::uuid`);
  add("T04", "alice: approving her own request is refused by the database", self.body.status === "error" && String(self.body.error).includes("not permitted or not found") && still.value === "pending", `error="${self.body.error}", row=${still.value}`, "", self.wall_ms);

  const ok = await agentCall(t, s.bob.jwt, tool("decide_request", { request_id: id, decision: "approved", note: "ok" }, true));
  const decided = await owner(st, `select status || ',' || (decided_by = ${lit(s.bob.id)}::uuid)::text from public.purchase_requests where id = ${lit(id)}::uuid`);
  add("T05", "bob (Sales manager): approving it works, decided_by is bob", ok.body.status === "ok" && decided.value === "approved,true", `status=${ok.body.status}, row=${decided.value}`, "", ok.wall_ms);

  // search_kb through the tool layer: real vectors + RLS on kb_chunks.
  const deptOf = new Map(
    (await owner(st, "select coalesce(string_agg(k.id::text || '=' || coalesce(d.name, 'company'), ','), '') from public.kb_chunks k left join public.departments d on d.id = k.department_id")).value
      .split(",")
      .filter(Boolean)
      .map((p) => p.split("=") as [string, string]),
  );
  const q = { query: "client entertainment spend: what to attach" };
  const a = await agentCall(t, s.alice.jwt, tool("search_kb", q));
  const c = await agentCall(t, s.carol.jwt, tool("search_kb", q));
  const hits = (x: typeof a) => (Array.isArray(x.body.result) ? (x.body.result as { id: string; title: string }[]) : []);
  const aDepts = hits(a).map((h) => deptOf.get(h.id) ?? "?");
  const cDepts = hits(c).map((h) => deptOf.get(h.id) ?? "?");
  add(
    "T06",
    "search_kb: alice's top hit is the Sales entertainment article; carol (Marketing) gets no Sales row",
    a.body.status === "ok" && hits(a)[0]?.title === "Sales client entertainment" && !aDepts.includes("Marketing") && c.body.status === "ok" && hits(c).length > 0 && !cDepts.includes("Sales") && !cDepts.includes("?"),
    `alice top=${hits(a)[0]?.title ?? "none"} (${[...new Set(aDepts)].join("/")}), carol ${hits(c).length} hits (${[...new Set(cDepts)].join("/")})`,
    "",
    a.wall_ms + c.wall_ms,
  );

  await owner(st, `delete from public.purchase_requests where justification like ${lit(`${MARK}%`)}`);
  return out;
}

const line = (id: string, c: AgentCheck) => {
  const tag = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status.toUpperCase();
  console.log(`${tag.padEnd(4)}  ${id.padEnd(6)} ${c.title}\n      ${c.detail}`);
  if (c.measurements) console.log(`      ${JSON.stringify(c.measurements)}`);
};

const checks: (AgentCheck & { id: string })[] = [];
let stackInfo: Record<string, number | string> = {};
let exitCode = 0;
try {
  prepareDir(SPEC);
  const t0 = Date.now();
  const st = await startStack(SPEC);
  const stackMs = Date.now() - t0;
  console.log(`local stack up in ${stackMs} ms at ${st.API_URL} (workdir ${SPEC.dir})`);
  await applySql(st, ["sql/00-baseline.sql", "sql/10-app.sql", "sql/20-agent.sql"]);
  console.log("applied sql/00-baseline.sql, sql/10-app.sql, sql/20-agent.sql");
  const users = await seed(st);
  const sessions = { alice: users.alice, bob: users.bob, carol: users.carol };
  const target = { functionsUrl: `${st.API_URL}/functions/v1`, publishableKey: st.PUBLISHABLE_KEY };

  serve = serveFunctions(SPEC, ENV_FILE);
  const ready = await waitReady(target, sessions.alice.jwt);
  stackInfo = { supabase_start_ms: stackMs, agent_ready_ms: ready.ready_ms, first_tool_call_ms: ready.first_ok_ms };
  console.log(`agent function ready after ${ready.ready_ms} ms (first ok tool call ${ready.first_ok_ms} ms)\n`);

  const e = await embedKb(st, target, sessions.alice.jwt);
  checks.push(e);
  line(e.id, e);
  for (const c of await toolChecks(st, target, sessions)) {
    checks.push(c);
    line(c.id, c);
  }

  console.log("\nK03 chat loop (live model calls)");
  for (const c of await agentChatChecks({ ...target, sessions, owner: (sql) => owner(st, sql) })) {
    const id = c.n === 0 ? "K03" : `K03.${String(c.n).padStart(2, "0")}`;
    checks.push({ ...c, id });
    line(id, c);
    if (c.status === "skip") console.log("      (locally: ANTHROPIC_API_KEY is not set in ENV_FILE)");
  }
} catch (err) {
  console.error(`ABORTED: ${(err as Error).message}`);
  exitCode = 2;
} finally {
  await teardown();
}

const failed = checks.filter((c) => c.status === "fail").length;
const passed = checks.filter((c) => c.status === "pass").length;
const other = checks.length - failed - passed;
if (failed && !exitCode) exitCode = 1;
mkdirSync(join(KIT, "evidence"), { recursive: true });
const out = join(KIT, "evidence", `agent-local-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  out,
  JSON.stringify({ started_at: startedAt.toISOString(), env_file: "provided (path passed to functions serve; contents not read)", stack: stackInfo, checks }, null, 2),
);
console.log(`\n${passed} pass, ${failed} fail${other ? `, ${other} skip/info` : ""}${exitCode === 2 ? " (aborted)" : ""} -> ${out}`);
process.exit(exitCode);
