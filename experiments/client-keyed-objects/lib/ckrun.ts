/**
 * Harness side of client-keyed-objects: what a CK module knows about the run.
 *
 * A run is a directory (gitignored, `work/run/`) written by the setup scripts:
 *
 *   run.json              {targets: [name...], fixtures, keysvc: {url, container}}
 *   targets/<name>.json   HarnessTarget (client config + harness-only access)
 *   state/<name>.json     TargetState (tenants, users, assets made by modules)
 *
 * The CLIENT gets only `client` (a TargetConfig) through the directory; the
 * harness-only fields (`kind`, service keys, SQL access, backend location)
 * exist so the suite can inspect each target, never so the client can branch.
 *
 * Secrets: targets/*.json and state/*.json hold keys and passwords; they never
 * enter a TestResult. `scrub()` replaces every secret value with a label.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

export const EXP_DIR = join(import.meta.dir, "..");
export const CLIENT_DIR = join(EXP_DIR, "client");

/** Same shape as client/src/ctx.ts TargetConfig (kept separate so the root typecheck stays off the client package). */
export interface ClientTarget {
  name: string;
  region: string;
  url: string;
  storageUrl: string;
  anonKey: string;
  s3: { endpoint: string; region: string; accessKeyId: string };
  keyServiceUrl: string;
  bucket: string;
}

export interface HarnessTarget {
  name: string;
  kind: "compose" | "managed";
  client: ClientTarget;
  serviceKey: string;
  /** Service-level S3 credentials (bypass RLS): the stack's protocol keys, or the session-token form with service_role. */
  s3Service: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Expected `iss` of access tokens. */
  issuer: string;
  compose?: { project: string; stackDir: string; backend: "file" | "s3"; dbContainer: string; storageImage: string };
  managed?: { ref: string; dbPass: string };
  /** URL rewrite for vantages inside Docker (key service, browser): from -> to. */
  dockerRewrite?: { from: string; to: string };
}

export interface User {
  email: string;
  password: string;
  id: string;
}

export interface TargetState {
  tenants: { primary: string; other: string };
  users: Record<"owner" | "editor" | "viewer" | "outsider", User>;
  records: { primary: string; other: string };
  /** Viewer access token minted at setup, kept to test expiry later (CK02). */
  earlyToken?: { token: string; exp: number };
  /** markerHits: plaintext-marker occurrences in the ciphertext, counted during a full read (CK04/CK05). */
  assets: Record<string, { id: string; tenant: string; method?: string; size?: number; markerHits?: number }>;
  setup?: Record<string, string | number>;
}

export interface RunInfo {
  dir: string;
  targets: string[];
  fixtures: { big: { path: string; size: number; sha256: string }; mid: { path: string; size: number; sha256: string } };
  keysvc: { url: string; container: string; configDir: string };
  onpremBaseline?: string;
}

export interface Loaded {
  run: RunInfo;
  targets: HarnessTarget[];
}

export function loadRun(ctx: Ctx): Loaded | { skip: string } {
  const dir = ctx.endpoints["ck_run_dir"] ?? "";
  if (!dir) return { skip: "PVLAB_ENDPOINT_CK_RUN_DIR not set (make onprem / make managed write it)" };
  if (!existsSync(join(dir, "run.json"))) return { skip: `no run.json in ${dir}` };
  const run = { ...(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunInfo), dir };
  const targets = run.targets.map((n) => JSON.parse(readFileSync(join(dir, "targets", `${n}.json`), "utf8")) as HarnessTarget);
  return { run, targets };
}

export const statePath = (run: RunInfo, t: string) => join(run.dir, "state", `${t}.json`);
export function loadState(run: RunInfo, t: string): TargetState {
  return JSON.parse(readFileSync(statePath(run, t), "utf8")) as TargetState;
}
export function saveState(run: RunInfo, t: string, s: TargetState): void {
  writeFileSync(statePath(run, t), JSON.stringify(s, null, 2));
}

/** The client's static directory for this run: every tenant -> its target's region. */
export function directory(l: Loaded): { tenants: Record<string, string>; regions: Record<string, ClientTarget> } {
  const tenants: Record<string, string> = {};
  const regions: Record<string, ClientTarget> = {};
  for (const t of l.targets) {
    regions[t.client.region] = t.client;
    const st = loadState(l.run, t.name);
    tenants[st.tenants.primary] = t.client.region;
    tenants[st.tenants.other] = t.client.region;
  }
  return { tenants, regions };
}

export function credsFor(l: Loaded, role: keyof TargetState["users"]): Record<string, { email: string; password: string }> {
  const out: Record<string, { email: string; password: string }> = {};
  for (const t of l.targets) {
    const u = loadState(l.run, t.name).users[role];
    out[t.client.region] = { email: u.email, password: u.password };
  }
  return out;
}

export function secretsOf(l: Loaded): string[] {
  const out: string[] = [];
  for (const t of l.targets) {
    out.push(t.client.anonKey, t.serviceKey, t.s3Service.secretAccessKey, t.s3Service.sessionToken ?? "", t.managed?.dbPass ?? "");
    if (existsSync(statePath(l.run, t.name))) {
      const st = loadState(l.run, t.name);
      for (const u of Object.values(st.users)) out.push(u.password);
      if (st.earlyToken) out.push(st.earlyToken.token);
    }
  }
  return out.filter((v) => v && v.length >= 8);
}

/** Replace secret values (and any JWT-shaped string) with labels. */
export function scrub(l: Loaded, s: string): string {
  let o = s;
  for (const v of secretsOf(l).sort((a, b) => b.length - a.length)) o = o.split(v).join("<secret>");
  return o.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>");
}

// ------------------------------------------------------------- processes

export interface Proc {
  code: number;
  out: string;
  err: string;
}

export async function sh(cmd: string[], o: { cwd?: string; stdin?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Proc> {
  const p = Bun.spawn(cmd, {
    cwd: o.cwd,
    stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: o.env ? { ...process.env, ...o.env } : undefined,
  });
  const timer = setTimeout(() => p.kill(), o.timeoutMs ?? 600_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err };
}

export interface ClientRun {
  result: Record<string, any>;
  killed: boolean;
  /** Fraction reached when killed. */
  killedAt?: number;
  ms: number;
  errTail: string;
}

/**
 * Run one client command in a child process (`bun client/cli.ts`). With
 * `killAt`, the child is SIGKILLed as soon as it reports that much progress:
 * an interruption, not a graceful stop.
 */
export async function runClient(cmd: Record<string, unknown>, o: { killAt?: number; timeoutMs?: number } = {}): Promise<ClientRun> {
  const t0 = performance.now();
  const p = Bun.spawn(["bun", "cli.ts"], { cwd: CLIENT_DIR, stdin: new Blob([JSON.stringify(cmd)]), stdout: "pipe", stderr: "pipe" });
  let killed = false;
  let killedAt: number | undefined;
  let errTail = "";
  const timer = setTimeout(() => p.kill(9), o.timeoutMs ?? 3_600_000);
  const readErr = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stderr as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^PROGRESS ([0-9.]+)$/.exec(line);
        if (m) {
          const f = Number(m[1]);
          if (o.killAt !== undefined && !killed && f >= o.killAt) {
            killed = true;
            killedAt = f;
            p.kill(9);
          }
        } else errTail = (errTail + line + "\n").slice(-2000);
      }
    }
  })();
  const out = await new Response(p.stdout).text();
  await readErr;
  await p.exited;
  clearTimeout(timer);
  const last = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
  let result: Record<string, any> = {};
  try {
    result = last ? (JSON.parse(last) as Record<string, any>) : {};
  } catch {
    result = { ok: false, code: "BadOutput", message: last.slice(0, 200) };
  }
  if (!last && !killed) result = { ok: false, code: "NoOutput", message: errTail.slice(-300) };
  return { result, killed, killedAt, ms: Math.round(performance.now() - t0), errTail };
}

// ------------------------------------------------------------- SQL

/** Rows of `query` as JSON objects, as `postgres`, on any target. */
export async function sqlRows(ctx: Ctx, t: HarnessTarget, query: string): Promise<Record<string, unknown>[]> {
  if (t.kind === "managed") {
    const r = await mgmtRetry(ctx, "POST", `/projects/${t.managed!.ref}/database/query`, { query });
    if (r.status >= 300) throw new Error(`sql HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  }
  const wrapped = `select coalesce(json_agg(q), '[]'::json) from (${query.replace(/;\s*$/, "")}) q`;
  const r = await sh(["docker", "exec", "-i", t.compose!.dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"], { stdin: wrapped });
  if (r.code !== 0) throw new Error(`psql: ${r.err.trim().slice(0, 300)}`);
  return JSON.parse(r.out.trim() || "[]") as Record<string, unknown>[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mgmtRetry(ctx: Ctx, method: string, path: string, body?: unknown) {
  let last = await mgmt(ctx, method, path, body);
  for (let i = 0; i < 6 && (last.throttled || last.status === 429); i++) {
    await sleep(15_000 * (i + 1));
    last = await mgmt(ctx, method, path, body);
  }
  return last;
}

// ------------------------------------------------------------- HTTP

export interface Resp {
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
}

export async function http(url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  const r = await http1(url, o);
  // One retry when there was no HTTP answer at all: Bun's fetch reuses pooled
  // keep-alive connections the far side has already closed ("The socket
  // connection was closed unexpectedly"), measured against the managed hosts.
  return r.status === 0 && /socket connection was closed/i.test(r.body) ? http1(url, o) : r;
}

async function http1(url: string, o: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Resp> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: o.method ?? "GET", headers: o.headers, body: o.body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    return { status: r.status, headers, body: await r.text(), ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, headers: {}, body: String((e as Error).message), ms: performance.now() - t0 };
  }
}

export const jsonOr = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Sign in with a password; returns the token response JSON (or the error body) and status. */
export async function signIn(t: HarnessTarget, email: string, password: string): Promise<{ status: number; j: any }> {
  const r = await http(`${t.client.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: t.client.anonKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, j: jsonOr(r.body) };
}

export function jwtPayload(jwt: string): Record<string, any> {
  const p = jwt.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

/** Shape of an error response: status, media type, sorted body keys (JSON) or element names (XML), and the code field. */
export function shape(r: Resp): { status: number; type: string; keys: string; code: string } {
  const type = (r.headers["content-type"] ?? "").split(";")[0]!.trim() || "-";
  const j = jsonOr(r.body);
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const keys = Object.keys(j).sort().join(",");
    const code = String(j.error_code ?? j.code ?? j.error ?? j.statusCode ?? "");
    return { status: r.status, type, keys, code };
  }
  const xml = [...r.body.matchAll(/<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1]).join(",");
  if (xml) return { status: r.status, type, keys: `xml:${xml}`, code: /<Code>([^<]*)<\/Code>/.exec(r.body)?.[1] ?? "" };
  return { status: r.status, type, keys: r.body ? "text" : "empty", code: r.body.slice(0, 40).replace(/\s+/g, " ") };
}

/** One TestResult per target, id `<ID>-<target>`. */
export function row(id: string, t: HarnessTarget, title: string, status: TestResult["status"], detail: string, measurements: Record<string, string | number> = {}): TestResult {
  return { id: `${id}-${t.name}`, title: `${title} [${t.name}]`, status, detail, measurements: { target: t.name, ...measurements } };
}

/** Service-level S3 config for the client's s3ops command (bypasses RLS). */
export function s3svc(t: HarnessTarget) {
  return { endpoint: t.client.s3.endpoint, region: t.client.s3.region, ...t.s3Service };
}

/** ASCII marker at the start of every fixture MiB (client/fixtures.ts). */
export const MARKER = "CK-PLAINTEXT-MARKER-";

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
