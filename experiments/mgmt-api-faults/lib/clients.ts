/**
 * The three clients MF06 / MF07 drive at a connection fault, each reporting
 * the same shape so one table holds them:
 *
 *   cli    the supabase CLI, pointed at the target with a `--profile` file
 *          (the CLI's own mechanism; nothing patched), `--debug` on
 *   bun    `fetch()` in this Bun process, AbortSignal.timeout 30 s, no retry
 *   node   `fetch()` (undici) in a `node` child process, same options
 *
 * The PAT and the create body (it carries the database password) reach the
 * node child through its environment, never argv. The CLI's `--db-password`
 * is argv because the command has no other non-interactive input for it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "./proxy.js";

export type ClientKind = "cli" | "bun" | "node";

export interface CallResult {
  client: ClientKind;
  /** HTTP status when one was heard; absent on a transport failure. */
  status?: number;
  /** CLI exit code (cli only). */
  exit?: number;
  /** Error name/code and the first message line, ports and refs scrubbed. */
  error?: string;
  ms: number;
  /** Raw text kept for evidence (scrubbed by the caller before publishing). */
  text: string;
}

const scrubPorts = (s: string) => s.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:{port}").replace(/localhost:\d+/g, "localhost:{port}");

export function profileFor(dir: string, base: string): string {
  const path = join(dir, `profile-${Math.random().toString(36).slice(2, 8)}.yaml`);
  writeFileSync(path, `name: mf\napi_url: ${base}\ndashboard_url: ${base}\ndocs_url: ${base}\nproject_host: supabase.co\n`);
  return path;
}

/** One CLI invocation against `base`. `args` is the subcommand, e.g. ["projects", "list"]. */
export async function cliCall(base: string, args: string[], pat: string, dir: string, timeoutMs = 400_000): Promise<CallResult> {
  const profile = profileFor(dir, base);
  const r = await runCmd(["supabase", "--profile", profile, "--workdir", dir, "--debug", ...args], {
    cwd: dir,
    env: { SUPABASE_ACCESS_TOKEN: pat },
    timeoutMs,
  });
  const lines = (r.stdout + "\n" + r.stderr).split("\n").filter((l) => l.trim() && !/^(Loading profile|Using (access token|profile)|Supabase CLI)/.test(l));
  const err = lines.filter((l) => !/HTTP (GET|POST|PUT|PATCH|DELETE):/.test(l)).find((l) => /error|fail|timed out/i.test(l));
  return {
    client: "cli",
    exit: r.timedOut ? -1 : (r.code ?? -1),
    error: r.code === 0 ? undefined : scrubPorts(err ?? lines[lines.length - 1] ?? (r.timedOut ? "killed at deadline" : "")).slice(0, 240),
    ms: r.ms,
    text: scrubPorts(lines.join("\n")).slice(0, 1500),
  };
}

function errText(e: unknown): string {
  const x = e as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = x.cause?.code ?? x.code ?? "";
  const msg = (x.cause?.message ?? x.message ?? String(e)).split("\n")[0];
  return scrubPorts(`${x.name ?? "Error"}${code ? ` ${code}` : ""}: ${msg}`).slice(0, 240);
}

/**
 * Plain fetch in this process. `pre` issues a GET to the same base first, so
 * the call under test can ride a kept-alive connection.
 */
export async function bunCall(base: string, method: string, path: string, pat: string, body?: unknown, pre = false): Promise<CallResult> {
  const headers = { Authorization: `Bearer ${pat}`, ...(body ? { "content-type": "application/json" } : {}) };
  if (pre) {
    try {
      const r = await fetch(`${base}/v1/projects`, { headers, signal: AbortSignal.timeout(30_000) });
      await r.arrayBuffer();
    } catch {
      /* the pre-request's own outcome is in the proxy log */
    }
  }
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    return { client: "bun", status: r.status, ms: Date.now() - t0, text: text.slice(0, 4000) };
  } catch (e) {
    return { client: "bun", error: errText(e), ms: Date.now() - t0, text: "" };
  }
}

const NODE_SCRIPT = `
const h = { Authorization: "Bearer " + process.env.SUPABASE_ACCESS_TOKEN };
if (process.env.B) h["content-type"] = "application/json";
const errText = (e) => { const c = e.cause || {}; return (e.name || "Error") + ((c.code || e.code) ? " " + (c.code || e.code) : "") + ": " + String(c.message || e.message).split("\\n")[0]; };
if (process.env.PRE === "1") { try { const r = await fetch(process.env.BASE + "/v1/projects", { headers: h, signal: AbortSignal.timeout(30000) }); await r.arrayBuffer(); } catch {} }
const t0 = Date.now();
try {
  const r = await fetch(process.env.BASE + process.env.P, { method: process.env.M, headers: h, body: process.env.B || undefined, signal: AbortSignal.timeout(30000) });
  const t = await r.text();
  console.log(JSON.stringify({ status: r.status, ms: Date.now() - t0, text: t.slice(0, 4000) }));
} catch (e) { console.log(JSON.stringify({ ms: Date.now() - t0, error: errText(e) })); }
`;

/** Plain fetch in a node child process (undici). */
export async function nodeCall(base: string, method: string, path: string, pat: string, body?: unknown, pre = false): Promise<CallResult> {
  const r = await runCmd(["node", "--input-type=module", "-e", NODE_SCRIPT], {
    env: { SUPABASE_ACCESS_TOKEN: pat, BASE: base, M: method, P: path, B: body ? JSON.stringify(body) : "", PRE: pre ? "1" : "0" },
    timeoutMs: 120_000,
  });
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as { status?: number; ms: number; text?: string; error?: string };
    return { client: "node", status: j.status, error: j.error ? scrubPorts(j.error).slice(0, 240) : undefined, ms: j.ms, text: j.text ?? "" };
  } catch {
    return { client: "node", error: `node child exit ${r.code}: ${scrubPorts(r.stderr).slice(0, 200)}`, ms: r.ms, text: "" };
  }
}
