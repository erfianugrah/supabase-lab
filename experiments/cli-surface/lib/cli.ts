/**
 * Process helpers for the CLI-surface modules: run a command with a timeout and
 * a clean environment, keep a per-run SUPABASE_HOME so the CLI's caches and
 * stored login never leak between runs, and stash raw output under the
 * experiment's evidence directory (gitignored).
 *
 * Environment hygiene matters here because the three things under test are
 * switched by environment: `SUPABASE_EXPERIMENTAL_STACK` picks the backend,
 * `SUPABASE_HOME` holds the shadow-database cache and the native service
 * artifacts, and an inherited `SUPABASE_ACCESS_TOKEN` would make a "no login"
 * probe silently authenticated. Every spawn starts from an allow-list.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestResult } from "../../../harness/src/types.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout then stderr, for assertions that do not care which stream a message used. */
  all: string;
  ms: number;
  timedOut: boolean;
}

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
}

/** Variables passed through from the parent; everything else is dropped. */
const PASS = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "SSL_CERT_FILE"];

export function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS) if (process.env[k]) out[k] = process.env[k]!;
  out.DO_NOT_TRACK = "1";
  out.SUPABASE_TELEMETRY_DISABLED = "1";
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

export async function run(cmd: string[], opts: RunOpts = {}): Promise<RunResult> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? baseEnv(),
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 300_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr, all: stdout + stderr, ms: Math.round(performance.now() - t0), timedOut };
}

/** The CLI under test; override to point at a specific build. */
export const SB = process.env.PVLAB_SUPABASE_CLI ?? "supabase";

/** The host CLI's `--version` output, or "absent" when the binary cannot be spawned (ENOENT). */
export async function cliVersion(): Promise<string> {
  try {
    const r = await run([SB, "--version"], { timeoutMs: 30_000 });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "absent";
  } catch {
    return "absent";
  }
}

/** Record the CLI version a module ran against in its first result's measurements. */
export function stamp(results: TestResult[], version: string): TestResult[] {
  const first = results.find((r) => r.measurements);
  if (first) first.measurements = { host_cli_version: version, ...first.measurements };
  else if (results[0]) results[0].detail = `${results[0].detail ?? ""} (host CLI ${version})`.trim();
  return results;
}

export function noCli(id: string, title: string): TestResult {
  return { id, title, status: "skip", detail: `the \`${SB}\` binary is not available on this host (spawn failed)` };
}

export async function dockerReachable(): Promise<boolean> {
  try {
    const r = await run(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---- evidence -------------------------------------------------------------

const here = import.meta.dir;
export const EVIDENCE_DIR = process.env.PVLAB_EVIDENCE ?? join(here, "..", "evidence", "raw");

/** Write a raw artifact next to the run; returns the path. Never throws. */
export function saveRaw(name: string, content: string): string {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const p = join(EVIDENCE_DIR, name);
    writeFileSync(p, content);
    return p;
  } catch {
    return "";
  }
}

/** Drop Docker pull progress lines so saved stderr is about the CLI, not the registry. */
export function quiet(s: string): string {
  return s
    .split("\n")
    .filter((l) => !/^[0-9a-f]{12}: (Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists)/.test(l))
    .join("\n");
}

/** Last `n` lines, for a result's `evidence` field. */
export function tail(s: string, n = 12): string {
  return s.trim().split("\n").slice(-n).join("\n");
}

/** Redact the local-dev keys and generated secrets a CLI prints, before they reach a result. */
export function scrub(s: string): string {
  return s
    .replace(/(?:\/private)?\/var\/folders\/[^\s"']*?\/cl-[A-Za-z0-9]+/g, "<tmp>")
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, "sb_$1_REDACTED")
    .replace(/\b[0-9a-f]{32,}\b/g, "HEX_REDACTED")
    .replace(/eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)*/g, "JWT_REDACTED");
}

// ---- local project --------------------------------------------------------

export interface PortPlan {
  api: number;
  db: number;
  shadow: number;
  pooler: number;
  studio: number;
  mail: number;
  analytics: number;
  inspector: number;
}

/** Ports for a project, one block of 10 per `slot`, clear of the CLI defaults (543xx, 8083). */
export function portPlan(base: number, slot: number): PortPlan {
  const b = base + slot * 10;
  return { api: b + 1, db: b + 2, shadow: b, pooler: b + 9, studio: b + 3, mail: b + 4, analytics: b + 7, inspector: b + 8 };
}

/**
 * Rewrite config.toml: project id, every port. Done by line so the generated
 * template (comments, section order) is otherwise untouched.
 */
export function patchConfig(toml: string, id: string, p: PortPlan): string {
  const section = (name: string, key: string, val: number) => (src: string) => {
    const re = new RegExp(`(^\\[${name.replace(/\./g, "\\.")}\\][^\\[]*?^${key} = )\\d+`, "ms");
    return src.replace(re, `$1${val}`);
  };
  let out = toml.replace(/^project_id = .*/m, `project_id = "${id}"`);
  for (const f of [
    section("api", "port", p.api),
    section("db", "port", p.db),
    section("db", "shadow_port", p.shadow),
    section("db.pooler", "port", p.pooler),
    section("studio", "port", p.studio),
    section("local_smtp", "port", p.mail),
    section("analytics", "port", p.analytics),
    section("edge_runtime", "inspector_port", p.inspector),
  ]) out = f(out);
  return out;
}

export interface LocalProject {
  dir: string;
  home: string;
  id: string;
  ports: PortPlan;
  dbUrl: string;
  env: (extra?: Record<string, string | undefined>) => Record<string, string>;
  sb: (args: string[], o?: { timeoutMs?: number; env?: Record<string, string | undefined> }) => Promise<RunResult>;
}

/**
 * A fresh `supabase init` project in a temp dir with its own SUPABASE_HOME and
 * a unique port block. The legacy backend is selected explicitly
 * (`SUPABASE_EXPERIMENTAL_STACK=0`) unless `stack` says otherwise.
 */
export async function initLocalProject(name: string, slot: number, opts: { stack?: "0" | "1"; portBase?: number } = {}): Promise<LocalProject> {
  const root = mkdtempSync(join(tmpdir(), "cl-"));
  const dir = join(root, name);
  const home = join(root, "home");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const ports = portPlan(opts.portBase ?? 58000, slot);
  const id = `pvlab-cli-${name}`;
  const env = (extra: Record<string, string | undefined> = {}) =>
    baseEnv({ SUPABASE_HOME: home, SUPABASE_EXPERIMENTAL_STACK: opts.stack ?? "0", ...extra });
  const sb = (args: string[], o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}) =>
    run([SB, ...args], { cwd: dir, env: env(o.env), timeoutMs: o.timeoutMs ?? 600_000 });
  const init = await sb(["init", "--force"]);
  if (init.code !== 0) throw new Error(`supabase init failed: ${tail(init.all, 5)}`);
  const cfgPath = join(dir, "supabase", "config.toml");
  const cfg = await Bun.file(cfgPath).text();
  writeFileSync(cfgPath, patchConfig(cfg, id, ports));
  return { dir, home, id, ports, dbUrl: `postgresql://postgres:postgres@127.0.0.1:${ports.db}/postgres`, env, sb };
}

export async function stopLocal(p: LocalProject): Promise<void> {
  await p.sb(["stop", "--no-backup", "--project-id", p.id], { timeoutMs: 120_000 }).catch(() => null);
  // Belt and braces: the legacy backend labels its containers and volumes with the project id.
  const ls = await run(["docker", "ps", "-aq", "--filter", `label=com.supabase.cli.project=${p.id}`]);
  const ids = ls.stdout.split("\n").filter(Boolean);
  if (ids.length) await run(["docker", "rm", "-f", ...ids]);
  const vols = await run(["docker", "volume", "ls", "-q", "--filter", `label=com.supabase.cli.project=${p.id}`]);
  const v = vols.stdout.split("\n").filter(Boolean);
  if (v.length) await run(["docker", "volume", "rm", "-f", ...v]);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
