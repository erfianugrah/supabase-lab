/**
 * Shared helpers for the jit-db-access module: Management API calls with a
 * throttle retry, a scrubbing psql wrapper (the PAT is the Postgres password
 * here, so it must never reach a result), and a held psql session used to ask
 * "does an OPEN connection survive expiry / revocation".
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import { connect } from "node:net";
import { mgmt, mgmtBase, type MgmtResponse } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nowS = () => Math.floor(Date.now() / 1000);

/** Words the scrubber replaces in anything that reaches a result. */
export class Scrub {
  private lits: Array<[string, string]> = [];
  add(value: string | undefined, label: string) {
    if (value && value.length > 3) this.lits.push([value, label]);
  }
  text(s: string): string {
    let out = s;
    for (const [v, l] of this.lits) out = out.split(v).join(l);
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ipv4>");
    out = out.replace(/[0-9a-f:]*::[0-9a-f:]*/gi, (m) => (m === "::1" ? m : "<ipv6>"));
    out = out.replace(/(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}/gi, "<ipv6>");
    out = out.replace(/aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com/g, "<pooler-host>");
    out = out.replace(/\b[a-z]{20}\b/g, "<20-letters>");
    return out.replace(/\s+/g, " ").trim();
  }
}

/** Management API call that waits out a throttle instead of recording it as a result. */
export async function api(ctx: Ctx, method: string, path: string, body?: unknown): Promise<MgmtResponse> {
  let r = await mgmt(ctx, method, path, body);
  for (let i = 0; i < 5 && (r.throttled || r.status === 429); i++) {
    await sleep(20_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

export function keysOf(j: unknown): string {
  if (Array.isArray(j)) return `[${j.length}]`;
  return j && typeof j === "object" ? Object.keys(j as object).sort().join(",") : "";
}

/** The caller's own user id, from the `x-gotrue-id` response header (GET /profile answers 403 to this PAT class). */
export async function callerUserId(ctx: Ctx): Promise<string> {
  const res = await fetch(`${mgmtBase(ctx)}/profile`, { headers: { Authorization: `Bearer ${ctx.pat}` } });
  await res.text();
  return res.headers.get("x-gotrue-id") ?? "";
}

export async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    const p = await api(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? "");
    if (status !== "ACTIVE_HEALTHY") await sleep(10_000);
  }
  return status;
}

export interface Target {
  /** Label used in rows. */
  name: string;
  host: string;
  /** Pin the address (direct host is AAAA-only; macOS getaddrinfo refuses it with no global v6 interface). */
  hostaddr?: string;
  port: number;
  user: string;
  /** libpq `options`, e.g. "-c jit=true". */
  options?: string;
}

export interface PsqlResult {
  ok: boolean;
  /** Scrubbed output (safe to record). */
  out: string;
  /** Unscrubbed stdout of a SUCCESSFUL statement, for values the caller registers with the scrubber itself. */
  raw: string;
  ms: number;
}

const POOLER_RE = /^aws-\d+-/;
export const isPooler = (t: Target) => POOLER_RE.test(t.host);

function conninfo(t: Target, app: string): string {
  const parts = [
    `host=${t.host}`,
    t.hostaddr ? `hostaddr=${t.hostaddr}` : "",
    `port=${t.port}`,
    `user=${t.user}`,
    "dbname=postgres",
    "sslmode=require",
    `application_name=${app}`,
    "connect_timeout=15",
    t.options ? `options='${t.options}'` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** One statement over one fresh connection. `password` is the PAT unless a control overrides it. */
export function psql(scrub: Scrub, t: Target, password: string, sql: string, app = "jitprobe"): PsqlResult {
  const t0 = Date.now();
  const r = spawnSync("psql", ["-X", "-tA", conninfo(t, app), "-c", sql], {
    env: { ...process.env, PGPASSWORD: password },
    encoding: "utf8",
    timeout: 30_000,
  });
  const raw = r.status === 0 ? r.stdout : `${r.stderr || ""}${r.stdout || ""}${r.error?.message ?? ""}`;
  return { ok: r.status === 0, out: scrub.text(raw), raw: r.status === 0 ? String(r.stdout).trim() : "", ms: Date.now() - t0 };
}

/** A psql process kept open; `ping()` is true while the backend still answers. */
export class Held {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private n = 0;
  exited = false;
  readonly openedAt = Date.now();
  constructor(t: Target, password: string, app: string) {
    this.child = spawn("psql", ["-X", "-tA", conninfo(t, app)], { env: { ...process.env, PGPASSWORD: password } });
    this.child.stdout.on("data", (d) => (this.buf += String(d)));
    this.child.stderr.on("data", (d) => (this.buf += String(d)));
    this.child.on("exit", () => (this.exited = true));
  }
  async ping(timeoutMs = 6000): Promise<boolean> {
    if (this.exited) return false;
    const tag = `hp${++this.n}x`;
    this.child.stdin.write(`select '${tag}';\n`);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.buf.includes(tag)) return true;
      if (this.exited) return false;
      await sleep(100);
    }
    return false;
  }
  close() {
    try {
      this.child.stdin.end("\\q\n");
    } catch {
      /* already gone */
    }
    setTimeout(() => this.child.kill(), 2000).unref();
  }
}

export async function resolveDirect(ref: string): Promise<{ v6: string[]; v4: string[] }> {
  const host = `db.${ref}.supabase.co`;
  const v6 = await dns.resolve6(host).catch(() => [] as string[]);
  const v4 = await dns.resolve4(host).catch(() => [] as string[]);
  return { v6, v4 };
}

/** True when `psql` runs on this machine (the module shells out to it). */
export function hasPsql(): boolean {
  const r = spawnSync("psql", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return !r.error && r.status === 0;
}

/**
 * True when this vantage can open an IPv6 TCP connection (a public resolver on
 * 443). The direct database hostname has only an AAAA record without the IPv4
 * add-on, so without a route every direct-path probe would fail.
 */
export function hasIpv6Route(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "2606:4700:4700::1111", port: 443, family: 6 });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Public IPv4 of this vantage, as Supavisor reports it (`peer_ip`). */
export async function vantageV4(): Promise<string> {
  try {
    const r = await fetch("https://api4.ipify.org", { signal: AbortSignal.timeout(8000) });
    const t = (await r.text()).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(t) ? t : "";
  } catch {
    return "";
  }
}

/**
 * Short code for a refusal, so a JIT denial can be told from the pooler's
 * circuit breaker (`(ECIRCUITBREAKER) too many authentication failures`),
 * which refuses even a valid credential and would otherwise be read as expiry.
 */
export function kindOf(out: string): string {
  const m = /\((E[A-Z_]+)\)/.exec(out);
  if (m?.[1]) return m[1];
  if (/PAM authentication failed/.test(out)) return "PAM";
  if (/password authentication failed/.test(out)) return "password";
  if (/SASL authentication failed/.test(out)) return "SASL";
  if (/timeout|could not connect|Connection refused/i.test(out)) return "network";
  return "other";
}
export const BREAKER = "ECIRCUITBREAKER";
