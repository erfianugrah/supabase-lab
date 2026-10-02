/**
 * Postgres connection paths and the two clients the modules drive them with:
 * libpq (psql 18, so `sslrootcert=system` and `sslnegotiation=direct` exist)
 * for the sslmode matrix, because sslmode semantics ARE libpq's; and
 * node-postgres for the server-side reads, because it exposes the client
 * socket's negotiated protocol and cipher.
 *
 * Paths are read off the platform, never constructed, using the
 * medium-serverless helpers: the shared pooler host is region-dependent, and
 * whether direct 5432 / dedicated 6543 are reachable from an IPv4-only vantage
 * depends on the IPv4 add-on (TL14 switches it on).
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx } from "../../../harness/src/types";
import { dedicatedTarget, directTarget, type PgTarget, primaryPooler, sharedTargets } from "../../medium-serverless/lib/setup";
import type { Target } from "./tls";

export interface PgPath extends PgTarget {
  reachable: boolean;
  /** Why not, when not. */
  why: string;
}

/**
 * A records via a fresh `dig`, not node:dns in this process: on 2026-10-02
 * TL14's in-process lookup never saw the IPv4 add-on's record on two runs
 * (12- and 20-minute budgets) while `dig` and the next process did. Cause not
 * established; every DNS-dependent path decision here goes through this.
 */
export async function hasA(host: string): Promise<boolean> {
  const out = (await $`dig +short ${host} A`.quiet().nothrow()).stdout.toString();
  return out.split("\n").some((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
}

export async function pgPaths(ctx: Ctx): Promise<PgPath[]> {
  const out: PgPath[] = [];
  const sv = ctx.pat ? await primaryPooler(ctx).catch(() => null) : null;
  if (sv) {
    const { session, txn } = sharedTargets(sv);
    out.push({ ...session, reachable: true, why: "" }, { ...txn, reachable: true, why: "" });
  }
  const why = (await hasA(ctx.phzHost)) ? "" : `no A record for ${ctx.phzHost} (IPv4 add-on off) and this vantage has no IPv6`;
  out.push({ ...directTarget(ctx), reachable: !why, why }, { ...dedicatedTarget(ctx), reachable: !why, why });
  return out;
}

export const tlsTarget = (p: PgPath): Target => ({ role: p.name, host: p.host, port: p.port, starttls: "postgres" });

export interface PsqlResult {
  ok: boolean;
  out: string;
  err: string;
  ms: number;
}

/**
 * One libpq connection with the given conninfo parameters, running `sql`.
 * The password travels in PGPASSWORD, never in the conninfo string, so it
 * cannot land in an error message.
 */
export async function psql(p: PgTarget, password: string, params: Record<string, string>, sql: string | string[]): Promise<PsqlResult> {
  const commands = (Array.isArray(sql) ? sql : [sql]).flatMap((c) => ["-c", c]);
  const conninfo = Object.entries({ host: p.host, port: String(p.port), user: p.user, dbname: "postgres", connect_timeout: "8", ...params })
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const t0 = Date.now();
  const r = await $`psql -X -A -t -v ON_ERROR_STOP=1 ${commands} ${conninfo}`.env({ ...process.env, PGPASSWORD: password, PGSSLMODE: "", PGSSLROOTCERT: "" }).quiet().nothrow();
  const err = r.stderr.toString().replace(/\s+/g, " ").trim();
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: err.replace(/^psql: (error: )?/, "").slice(0, 240), ms: Date.now() - t0 };
}

/**
 * Pure: psql 18 `\conninfo` (-A -t: `key|value` rows) -> the client leg's
 * TLS, plus whatever followed (the next command's output). `client` is
 * "TLSv1.3 <cipher>", "plaintext", or "?" when no conninfo block is present.
 */
export function parseConninfo(out: string): { client: string; rest: string } {
  const kv: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^(Database|Client User|Host|Host Address|Server Port|Options|Protocol Version|Password Used|GSSAPI Authenticated|Backend PID|SSL Connection|SSL Library|SSL Protocol|SSL Key Bits|SSL Cipher|SSL Compression|ALPN|Superuser|Hot Standby)\|(.*)$/.exec(line);
    if (m?.[1]) kv[m[1]] = m[2] ?? "";
    else if (line.trim()) rest.push(line.trim());
  }
  const client = kv["SSL Connection"] === "true" ? `${kv["SSL Protocol"] ?? "?"} ${kv["SSL Cipher"] ?? "?"}` : kv["SSL Connection"] === "false" ? "plaintext" : "?";
  return { client, rest: rest.join(" ") };
}

/**
 * Pure: is this connection error the SSL-enforcement refusal, as opposed to
 * the restart the switch triggers? Matches only the three refusal texts
 * seen per path on 2026-10-02 (Supavisor `ESSLREQUIRED`, Postgres hba `no
 * encryption`, PgBouncer `SSL required`); a restart's `Connection refused`,
 * `SSL SYSCALL error`, or "shutting down" is not a refusal.
 */
export function isEnforcementRefusal(err: string): boolean {
  return /ESSLREQUIRED|SSL connection is required|no pg_hba\.conf entry.*no encryption|FATAL: SSL required/.test(err);
}

/** What this session's backend reports about its own TLS (the hop INTO Postgres). */
export const SELF_SSL_SQL = "select coalesce(s.ssl::text,'?')||'|'||coalesce(s.version,'-')||'|'||coalesce(s.cipher,'-') from pg_stat_ssl s where s.pid = pg_backend_pid()";

export interface NodeSession {
  ok: boolean;
  err: string;
  /** Client socket, as negotiated with whatever answered (pooler or Postgres). */
  clientProtocol: string;
  clientCipher: string;
  rows: Record<string, unknown>[];
}

/**
 * node-postgres session that runs `sql` and reads the socket's TLS parameters.
 * Verification is off on purpose: this session measures what gets
 * negotiated, and certificate verification is TL12's job (libpq, every
 * sslmode, explicit roots), where a failure is the measurement.
 */
export async function nodeSession(p: PgTarget, password: string, sql: string): Promise<NodeSession> {
  const c = new Client({ host: p.host, port: p.port, user: p.user, database: "postgres", password, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try {
    await c.connect();
    const sock = (c as unknown as { connection?: { stream?: { getProtocol?: () => string; getCipher?: () => { name?: string } } } }).connection?.stream;
    const res = await c.query(sql);
    return { ok: true, err: "", clientProtocol: sock?.getProtocol?.() ?? "?", clientCipher: sock?.getCipher?.()?.name ?? "?", rows: res.rows };
  } catch (e) {
    return { ok: false, err: (e instanceof Error ? e.message : String(e)).slice(0, 240), clientProtocol: "", clientCipher: "", rows: [] };
  } finally {
    await c.end().catch(() => {});
  }
}
