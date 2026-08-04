/**
 * Shared mechanics for the tenant-promotion experiment.
 *
 * Lives outside `tests/` on purpose: the registry generator imports every
 * `.ts` under an experiment's tests directory as a default-exported
 * TestModule, so a helper file dropped in there becomes an `undefined` entry
 * in the registry array.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export const PASSWORD = "LabPassword123!";

export interface SqlResult {
  status: number;
  rows?: Record<string, unknown>[];
  /** Postgres error message as the query endpoint reports it. */
  error?: string;
  /** SQLSTATE when the endpoint supplies one. */
  code?: string;
  text: string;
}

/**
 * The Management API query endpoint. Errors come back as a JSON object rather
 * than an array, and the shape has varied (`message` vs `error`), so both are
 * read and the raw text is kept for evidence.
 */
export async function sql(ctx: Ctx, ref: string, query: string): Promise<SqlResult> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 60000);
  if (Array.isArray(r.json)) {
    return { status: r.status, rows: r.json as Record<string, unknown>[], text: r.text };
  }
  const o = (r.json ?? {}) as Record<string, unknown>;
  return {
    status: r.status,
    error: typeof o.message === "string" ? o.message : typeof o.error === "string" ? o.error : r.text,
    code: typeof o.code === "string" ? o.code : undefined,
    text: r.text,
  };
}

/** SQLSTATE is not always a field; the message carries it often enough to be worth mining. */
export function sqlstate(r: SqlResult): string {
  if (r.code) return r.code;
  const m = /\b(\d{2}[0-9A-Z]{3})\b/.exec(r.error ?? "");
  return m?.[1] ?? "none";
}

export async function keys(ctx: Ctx, ref: string): Promise<{ anon?: string; service?: string }> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const arr = Array.isArray(r.json) ? (r.json as Record<string, string>[]) : [];
  // Select by name: projects now carry both the legacy JWT pair and the newer
  // sb_publishable_/sb_secret_ pair, and sending a non-JWT as a bearer returns
  // PGRST301 "Expected 3 parts in JWT", which reads like an auth finding.
  const pick = (name: string) => arr.find((k) => k.name === name)?.api_key;
  return { anon: pick("anon"), service: pick("service_role") };
}

export interface AuthResponse {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

async function authCall(
  host: string,
  path: string,
  init: RequestInit & { apikey: string; bearer?: string },
): Promise<AuthResponse> {
  const { apikey, bearer, ...rest } = init;
  const res = await fetch(`https://${host}/auth/v1${path}`, {
    ...rest,
    headers: {
      apikey,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

/**
 * Create a user through the admin API.
 *
 * Retries once on 500: on a fresh project the first admin write can fail with
 * "Database error checking email" even after every service health-checks
 * ACTIVE_HEALTHY, and recording that as a finding would be wrong.
 */
export async function adminCreate(
  host: string,
  service: string,
  body: Record<string, unknown>,
): Promise<AuthResponse> {
  let r = await authCall(host, "/admin/users", {
    method: "POST",
    apikey: service,
    bearer: service,
    body: JSON.stringify(body),
  });
  if (r.status >= 500) {
    await new Promise((x) => setTimeout(x, 12000));
    r = await authCall(host, "/admin/users", {
      method: "POST",
      apikey: service,
      bearer: service,
      body: JSON.stringify(body),
    });
  }
  return r;
}

export async function login(
  host: string,
  anon: string,
  email: string,
  password = PASSWORD,
): Promise<AuthResponse> {
  return authCall(host, "/token?grant_type=password", {
    method: "POST",
    apikey: anon,
    body: JSON.stringify({ email, password }),
  });
}

/** Decode a JWT payload without verifying it - the signature is the platform's business. */
export function claims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface Read {
  status: number;
  rows?: unknown[];
  code?: string;
  text: string;
}

export async function restRead(
  host: string,
  anon: string,
  bearer: string,
  query: string,
): Promise<Read> {
  const res = await fetch(`https://${host}/rest/v1/${query}`, {
    headers: { apikey: anon, Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let rows: unknown[] | undefined;
  let code: string | undefined;
  try {
    const j = JSON.parse(text) as unknown;
    if (Array.isArray(j)) rows = j;
    else code = typeof (j as Record<string, unknown>).code === "string"
      ? ((j as Record<string, string>).code)
      : undefined;
  } catch {
    /* non-json */
  }
  return { status: res.status, rows, code, text };
}

/**
 * `representation` is PostgREST's default and it conflates two outcomes: an
 * INSERT returning ... RETURNING whose new row the SELECT policy hides fails
 * with the same 42501 as an INSERT the WITH CHECK expression refused. Any
 * test that wants to know whether the WRITE was allowed has to ask for
 * `minimal` and then count rows server-side.
 */
export async function restWrite(
  host: string,
  anon: string,
  bearer: string,
  table: string,
  body: unknown,
  prefer: "representation" | "minimal" = "representation",
): Promise<Read> {
  const res = await fetch(`https://${host}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Prefer: `return=${prefer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let rows: unknown[] | undefined;
  let code: string | undefined;
  try {
    const j = JSON.parse(text) as unknown;
    if (Array.isArray(j)) rows = j;
    else code = typeof (j as Record<string, unknown>).code === "string"
      ? ((j as Record<string, string>).code)
      : undefined;
  } catch {
    /* non-json */
  }
  return { status: res.status, rows, code, text };
}

/**
 * Per-service readiness. The aggregate project status flipping to
 * ACTIVE_HEALTHY does not mean auth and rest will answer.
 */
export async function waitReady(ctx: Ctx, ref: string, budgetMs = 300000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs) {
    const r = await mgmt(ctx, "GET", `/projects/${ref}/health?services=auth&services=rest&services=db`);
    const arr = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
    if (arr.length >= 3 && arr.every((s) => s.status === "ACTIVE_HEALTHY")) return true;
    await new Promise((x) => setTimeout(x, 5000));
  }
  return false;
}

/** A dollar-quote tag that cannot appear in the payload it wraps. */
export function tag(): string {
  return `$m${Math.random().toString(36).slice(2, 10)}$`;
}

export async function nonGeneratedColumns(
  ctx: Ctx,
  ref: string,
  schema: string,
  table: string,
): Promise<string[]> {
  const r = await sql(
    ctx,
    ref,
    `select column_name from information_schema.columns
      where table_schema = '${schema}' and table_name = '${table}' and is_generated = 'NEVER'
      order by ordinal_position`,
  );
  return (r.rows ?? []).map((x) => String(x.column_name));
}

export interface CopyOutcome {
  /** Rows read from the source. */
  read: number;
  /** Columns actually copied (source-target intersection, non-generated). */
  cols: number;
  result: SqlResult;
}

/**
 * Copy rows of one table from one project to another through the query
 * endpoint, enumerating columns from BOTH catalogs and using the
 * intersection: two projects created months apart run different auth schema
 * versions, and `insert ... select *` cannot work anyway because
 * auth.users.confirmed_at is GENERATED ALWAYS.
 */
export async function copyTable(
  ctx: Ctx,
  from: string,
  to: string,
  schema: string,
  table: string,
  where = "true",
  /**
   * Column -> SQL expression applied on the way in. The one realistic way
   * past a merge conflict is to change the conflicting value, and doing it in
   * the insert keeps the source untouched.
   */
  rewrite: Record<string, string> = {},
): Promise<CopyOutcome> {
  const src = await nonGeneratedColumns(ctx, from, schema, table);
  const dst = new Set(await nonGeneratedColumns(ctx, to, schema, table));
  const cols = src.filter((c) => dst.has(c));
  const list = cols.map((c) => `"${c}"`).join(",");
  const selectList = cols.map((c) => rewrite[c] ?? `"${c}"`).join(",");

  const dump = await sql(
    ctx,
    from,
    `select coalesce(json_agg(t), '[]'::json)::text as payload
       from (select ${list} from ${schema}.${table} where ${where}) t`,
  );
  const payload = String(dump.rows?.[0]?.payload ?? "[]");
  const rows = JSON.parse(payload) as unknown[];
  const t = tag();
  const result = await sql(
    ctx,
    to,
    `insert into ${schema}.${table} (${list})
       select ${selectList} from json_populate_recordset(null::${schema}.${table}, ${t}${payload}${t}::json)`,
  );
  return { read: rows.length, cols: cols.length, result };
}

/**
 * Refresh a token against a project's auth endpoint, returning the new
 * access token. This is distinct from a password login - the client already
 * holds a refresh token and presents it to mint a new session at whatever
 * project the token was issued by (and, after promotion, at the dedicated
 * project that now holds the auth row).
 */
export async function refreshSession(
  host: string,
  anon: string,
  refreshToken: string,
): Promise<AuthResponse> {
  return authCall(host, "/token?grant_type=refresh_token", {
    method: "POST",
    apikey: anon,
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}
/**
 * Resync a copied table's sequence to its own max(id).
 *
 * Copying `auth.refresh_tokens` moves the ROWS but leaves the target's
 * sequence untouched, so the next `nextval()` hands out an id that already
 * exists. GoTrue rotates the refresh token on every use, which means the
 * collision does not surface during the promotion at all - it surfaces on the
 * tenant's FIRST REFRESH afterwards, and looks like session porting having
 * silently failed. The copy is only finished once this has run.
 */
export async function resyncSequence(
  ctx: Ctx,
  ref: string,
  sequence: string,
  schema: string,
  table: string,
  column = "id",
): Promise<{ result: SqlResult; lastValue: string }> {
  const result = await sql(
    ctx,
    ref,
    `select setval('${sequence}',
       coalesce((select max("${column}") from ${schema}.${table}), 1), true) as v`,
  );
  return { result, lastValue: String(result.rows?.[0]?.v ?? "unknown") };
}
