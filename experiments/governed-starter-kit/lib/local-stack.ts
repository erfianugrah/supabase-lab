/**
 * A throwaway local Supabase stack in Docker for the kit's local runners
 * (scripts/bff-local.ts, scripts/agent-local.ts). Nothing hosted is touched.
 *
 * Each runner gets its own workdir, project id and port block, so two runners
 * (or a default local stack on 5432x) can run side by side: `supabase init`
 * once in the workdir, then the 5432x ports in config.toml are rewritten to
 * the runner's block (5442x for bff-local, 5452x for agent-local). Only db,
 * auth (gotrue), rest (postgrest) and kong come up from `supabase start`;
 * `supabase functions serve` runs its own edge runtime.
 *
 * SQL goes through psql to the stack's DB_URL; users are created through the
 * Auth admin API with the stack's secret key, so the signup trigger in
 * sql/00-baseline.sql runs as it would for a real user.
 */
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const KIT = resolve(import.meta.dir, "..");

const EXCLUDE = "studio,imgproxy,storage-api,realtime,mailpit,logflare,vector,supavisor,postgres-meta,edge-runtime";

export interface StackSpec {
  /** Workdir holding supabase/config.toml and the copied functions. */
  dir: string;
  projectId: string;
  /** Replaces the "543" of the default 5432x ports, e.g. "544" -> 5442x. */
  portBlock: string;
  /** Function directories under supabase/functions to copy and serve. */
  functions: string[];
  /** Extra config.toml text appended once (e.g. a [functions.x] block). */
  extraConfig?: string;
}

export interface Status {
  API_URL: string;
  DB_URL: string;
  PUBLISHABLE_KEY: string;
  SECRET_KEY: string;
  SERVICE_ROLE_KEY: string;
}

export interface Session {
  id: string;
  jwt: string;
}

export const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function prepareDir(spec: StackSpec) {
  mkdirSync(spec.dir, { recursive: true });
  const cfgPath = join(spec.dir, "supabase", "config.toml");
  if (!existsSync(cfgPath)) {
    const r = Bun.spawnSync(["supabase", "init", "--yes"], { cwd: spec.dir, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`supabase init: ${r.stderr.toString().slice(0, 400)}`);
  }
  let cfg = readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/^project_id = .*$/m, `project_id = "${spec.projectId}"`).replace(/\b543(2\d)\b/g, `${spec.portBlock}$1`);
  if (spec.extraConfig && !cfg.includes(spec.extraConfig.trim())) cfg += `\n${spec.extraConfig}`;
  writeFileSync(cfgPath, cfg);
  // A copy, not a symlink: the edge runtime container mounts this directory.
  const fnDir = join(spec.dir, "supabase", "functions");
  rmSync(fnDir, { recursive: true, force: true });
  for (const f of spec.functions) cpSync(join(KIT, "supabase", "functions", f), join(fnDir, f), { recursive: true });
}

export async function startStack(spec: StackSpec): Promise<Status> {
  const r = await $`supabase start --workdir ${spec.dir} -x ${EXCLUDE}`.quiet().nothrow();
  if (r.exitCode !== 0 && !/already running/i.test(r.stderr.toString())) {
    throw new Error(`supabase start: ${r.stderr.toString().slice(-600)}`);
  }
  const st = await $`supabase status --workdir ${spec.dir} -o json`.quiet().nothrow();
  return JSON.parse(st.stdout.toString()) as Status;
}

export async function stopStack(spec: StackSpec) {
  await $`supabase stop --workdir ${spec.dir} --no-backup`.quiet().nothrow();
}

export async function applySql(st: Status, files: string[]) {
  for (const f of files) {
    const r = await $`psql ${st.DB_URL} -v ON_ERROR_STOP=1 -q -f ${join(KIT, f)}`.quiet().nothrow();
    if (r.exitCode !== 0) throw new Error(`${f}: ${r.stderr.toString().slice(0, 600)}`);
  }
}

/** Run one statement batch as postgres; the last output line is the value. */
export async function owner(st: Status, sqlText: string): Promise<{ ok: boolean; value: string }> {
  const p = await $`psql ${st.DB_URL} -qAt -v ON_ERROR_STOP=1 -c ${sqlText}`.quiet().nothrow();
  const out = p.stdout.toString().trim();
  if (p.exitCode !== 0) return { ok: false, value: p.stderr.toString().trim() || out };
  return { ok: true, value: out.split("\n").filter(Boolean).pop() ?? "" };
}

/**
 * Create (or recreate) a user through the Auth admin API and sign in with the
 * publishable key. A user of the same email from a KEEP=1 run is deleted
 * first, so the password is always the one passed in.
 */
export async function createUser(
  st: Status,
  email: string,
  password: string,
  meta: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } = {},
): Promise<Session> {
  const admin = { apikey: st.SECRET_KEY, Authorization: `Bearer ${st.SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  const list = (await (await fetch(`${st.API_URL}/auth/v1/admin/users?per_page=100`, { headers: admin })).json()) as { users?: { id: string; email: string }[] };
  for (const u of list.users ?? []) {
    if (u.email === email) await fetch(`${st.API_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  const c = await fetch(`${st.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true, ...meta }),
  });
  if (!c.ok) throw new Error(`create ${email}: http ${c.status} ${(await c.text()).slice(0, 200)}`);
  const s = await fetch(`${st.API_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: st.PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!s.ok) throw new Error(`sign-in ${email}: http ${s.status}`);
  const j = (await s.json()) as { access_token: string; user: { id: string } };
  return { id: j.user.id, jwt: j.access_token };
}

/** `supabase functions serve` for the workdir, output to <dir>/functions-serve.log. */
export function serveFunctions(spec: StackSpec, envFile: string): Bun.Subprocess {
  // One fd for both streams: two Bun.file handles each write from offset 0
  // and overwrite each other.
  const log = openSync(join(spec.dir, "functions-serve.log"), "w");
  return Bun.spawn(["supabase", "functions", "serve", "--workdir", spec.dir, "--env-file", envFile], { stdout: log, stderr: log });
}
