/**
 * Helpers for the MF modules: start and stop the fault-injecting proxy
 * container, set rules, read its log, run a child process with a deadline, and
 * sweep the org for projects this experiment created.
 *
 * Every project this experiment creates carries NAME_PREFIX, and `sweep()`
 * deletes only names that start with it.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx } from "../../../harness/src/types.js";

export const NAME_PREFIX = "mf-";
const PROXY_DIR = resolve(import.meta.dir, "../proxy");
const IMAGE = "oven/bun:1";

export interface Rule {
  id: string;
  method?: string;
  path: string;
  mode: "error-before" | "error-after" | "delay-before" | "delay-after" | "passthrough";
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
  body?: string;
  skip?: number;
  times?: number;
}

export interface LogRow {
  seq: number;
  t: number;
  method: string;
  path: string;
  bodyBytes: number;
  bodySha: string;
  rule?: string;
  action: string;
  clientStatus?: number;
  upstreamStatus?: number;
  upstreamRef?: string;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Proxy {
  url: string;
  setRules(rules: Rule[]): Promise<void>;
  reset(): Promise<void>;
  log(): Promise<LogRow[]>;
  stop(): Promise<void>;
}

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}

/**
 * Probe the local tools a module shells out to. Returns a reason string naming
 * what is missing (for a `skip` result), or null when everything is present.
 * "docker" also checks that the daemon answers, since the fault proxy runs in
 * a container.
 */
export async function missingTool(tools: Array<"docker" | "tofu" | "supabase">): Promise<string | null> {
  for (const t of tools) {
    if (!Bun.which(t)) return `${t} not found on PATH`;
  }
  if (tools.includes("docker")) {
    const info = await sh(["docker", "info", "--format", "{{.ServerVersion}}"]).catch((e) => ({ code: 1, out: String(e) }));
    if (info.code !== 0) return "docker daemon not reachable";
  }
  return null;
}

let nextPort = 18100 + Math.floor(Math.random() * 400);

export async function startProxy(): Promise<Proxy> {
  const port = nextPort++;
  const name = `mf-proxy-${port}`;
  const run = await sh([
    "docker", "run", "-d", "--rm", "--name", name,
    "-p", `127.0.0.1:${port}:8080`,
    "-v", `${PROXY_DIR}:/app:ro`,
    IMAGE, "bun", "/app/server.ts",
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out.slice(0, 300)}`);
  const url = `http://127.0.0.1:${port}`;
  const admin = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${url}/__admin/${path}`, init);
    return r.json();
  };
  const t0 = Date.now();
  for (;;) {
    try {
      await admin("health");
      break;
    } catch {
      if (Date.now() - t0 > 20_000) {
        await sh(["docker", "rm", "-f", name]);
        throw new Error("proxy did not become healthy in 20 s");
      }
      await sleep(300);
    }
  }
  return {
    url,
    setRules: async (rules) => {
      await admin("rules", { method: "PUT", body: JSON.stringify(rules), headers: { "content-type": "application/json" } });
    },
    reset: async () => {
      await admin("reset");
    },
    log: async () => (await admin("log")) as LogRow[],
    stop: async () => {
      await sh(["docker", "rm", "-f", name]);
    },
  };
}

export async function withProxy<T>(fn: (px: Proxy) => Promise<T>): Promise<T> {
  const px = await startProxy();
  try {
    return await fn(px);
  } finally {
    await px.stop();
  }
}

/** Requests in the log matching a method and path regex (the attempt count for one logical call). */
export function attempts(log: LogRow[], method: string, pathRe: RegExp): LogRow[] {
  return log.filter((r) => r.method === method && pathRe.test(r.path));
}

export interface Ran {
  code: number | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}

/** Run a child process with a hard deadline; kills it on timeout. */
export async function runCmd(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Ran> {
  const t0 = Date.now();
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, opts.timeoutMs ?? 120_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, timedOut, ms: Date.now() - t0, stdout, stderr };
}

/** Projects under the prefix, read DIRECTLY from the Management API (never through the proxy). */
export async function listPrefixed(ctx: Ctx): Promise<Array<{ ref: string; name: string; status: string }>> {
  const direct = { ...ctx, mgmtBase: "https://api.supabase.com/v1" } as Ctx;
  const r = await mgmt(direct, "GET", "/projects");
  const arr = Array.isArray(r.json) ? (r.json as Array<{ id?: string; ref?: string; name?: string; status?: string }>) : [];
  return arr
    .filter((p) => (p.name ?? "").startsWith(NAME_PREFIX))
    .map((p) => ({ ref: p.ref ?? p.id ?? "", name: p.name ?? "", status: p.status ?? "" }));
}

/** Delete every prefixed project (direct), return how many DELETEs were accepted. */
export async function sweep(ctx: Ctx, only?: (name: string) => boolean): Promise<number> {
  const direct = { ...ctx, mgmtBase: "https://api.supabase.com/v1" } as Ctx;
  let n = 0;
  for (const p of await listPrefixed(ctx)) {
    if (only && !only(p.name)) continue;
    const d = await mgmt(direct, "DELETE", `/projects/${p.ref}`);
    if (d.status >= 200 && d.status < 300) n++;
    await sleep(1500);
  }
  return n;
}

/** Wait until no prefixed project with the given name filter remains listed. */
export async function waitGone(ctx: Ctx, only?: (name: string) => boolean, maxMs = 180_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const left = (await listPrefixed(ctx)).filter((p) => (only ? only(p.name) : true));
    if (left.length === 0) return true;
    await sleep(10_000);
  }
  return false;
}

export function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `mf-${label}-`));
}

export function dbPassword(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}Aa1!`;
}

export { writeFileSync };

/** Collapse a proxy log to "METHOD path-shape action -> clientStatus xN" lines; refs become {ref}. */
export function shape(log: LogRow[]): string {
  const counts = new Map<string, number>();
  for (const r of log) {
    const p = r.path.replace(/\b[a-z]{20}\b/g, "{ref}").replace(/\?.*$/, "");
    const k = `${r.method} ${p} ${r.action} -> ${r.clientStatus ?? "?"}${r.upstreamStatus && r.upstreamStatus !== r.clientStatus ? ` (upstream ${r.upstreamStatus})` : ""}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${n}x ${k}`).join("\n");
}

/** Replace project refs in captured text so evidence carries no identifiers. */
export function scrub(s: string): string {
  return s.replace(/\b[a-z]{20}\b/g, "{ref}");
}
