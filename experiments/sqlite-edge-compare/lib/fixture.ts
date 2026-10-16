#!/usr/bin/env bun
/**
 * sqlite-edge-compare fixture: one of each backend in Sydney plus one probe
 * Worker bound to all of them. Everything is named `sec-<kind>-<stamp>`.
 *
 *   bun lib/fixture.ts up        create (resumes a partial .fixture.json)
 *   bun lib/fixture.ts down      delete what .fixture.json names; idempotent
 *   bun lib/fixture.ts status    what exists, by name
 *   bun lib/fixture.ts env       shell `export` lines for `make probe` (eval'd, not printed)
 *   bun lib/fixture.ts cleanup [--dry-run]   delete every sec-* leftover on all three vendors
 *   bun lib/fixture.ts literals  identifiers to redact at publish time (comma list, for env)
 *
 * up creates:
 *   - Supabase Micro project on the Pro org (PVLAB_ORG_PRO), ap-southeast-2,
 *     waited past ACTIVE_HEALTHY until SQL, the pooler, the direct host and
 *     PostgREST each answer (AGENTS.md "ACTIVE_HEALTHY is not readiness")
 *   - Turso group sec-syd (aws-ap-southeast-2; Free allows one group) and a
 *     libSQL database in it, plus a full-access DB token (7-day expiry)
 *   - D1 database, location hint oc, read replication left at default
 *   - two Hyperdrive configs on the Supabase direct string: caching disabled
 *     and caching enabled
 *   - the probe Worker (worker/index.ts, nodejs_compat, workers.dev, Smart
 *     Placement off) with the bindings and secrets above and a random probe key
 * and writes .fixture.json (gitignored, mode 0600: it holds the DB password,
 * the secret key, the Turso token and the probe key).
 *
 * Credentials: env only (sx per command). SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO,
 * CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY/CLOUDFLARE_ACCOUNT_ID, TURSO_API_TOKEN,
 * PVLAB_TURSO_ORG. wrangler gets the Cloudflare trio through its environment;
 * secrets go to `wrangler secret bulk` on stdin, never argv.
 */
import { spawn } from "node:child_process";
import { resolve6 } from "node:dns/promises";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { buildCtx } from "../../../harness/src/ctx";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql as platformSql } from "../../../harness/src/platform";
import type { Ctx } from "../../../harness/src/types";
import { D1_LOCATION_HINT, type MetaResponse, PREFIX, SUPABASE_REGION, TURSO_GROUP, TURSO_LOCATION } from "./contract";
import {
  type CfCreds,
  cfCreds,
  createD1,
  createHyperdrive,
  createTursoDb,
  createTursoGroup,
  d1Rest,
  deleteD1,
  deleteHyperdrive,
  deleteSbProject,
  deleteTursoDb,
  deleteTursoGroup,
  deleteWorker,
  goneOk,
  listD1,
  listDoNamespaces,
  listHyperdrive,
  listSecProjects,
  listTurso,
  listWorkers,
  secOnly,
  sleep,
  type TursoCreds,
  tursoCreds,
  tursoDbToken,
  workersSubdomain,
} from "./vendors";

export const EXP_DIR = resolve(import.meta.dir, "..");
export const ROOT = resolve(EXP_DIR, "../..");
export const FIXTURE_FILE = resolve(EXP_DIR, ".fixture.json");
export const WRANGLER_FILE = resolve(EXP_DIR, "wrangler.jsonc");
export const COMPAT_DATE = "2026-09-01";

export interface Named {
  name: string;
  id: string;
}

export interface Fixture {
  version: 1;
  stamp: string;
  createdAt: string;
  updatedAt: string;
  supabase?: {
    name: string;
    ref: string;
    region: string;
    org: string;
    dbPass: string;
    url: string;
    directHost: string;
    poolerHost?: string;
    poolerUser?: string;
    secretKey?: string;
    publishableKey?: string;
    anonKey?: string;
    serviceKey?: string;
    /** ms from create to ACTIVE_HEALTHY, and to every readiness check passing. */
    healthyMs?: number;
    readyMs?: number;
    readiness?: Record<string, string>;
  };
  turso?: {
    org: string;
    group: string;
    groupCreated: boolean;
    location: string;
    db: string;
    hostname: string;
    url: string;
    token?: string;
  };
  /** Turso-engine database in the same group; `error` when the org refuses use_tursodb. */
  tursodb?: { db: string; hostname?: string; url?: string; dbId?: string; token?: string; createMs?: number; error?: string };
  d1?: { name: string; id: string; locationHint: string; createInfo?: Record<string, unknown> };
  hyperdrive?: { nocache?: Named; cached?: Named };
  worker?: { name: string; url: string; probeKey: string; compatDate: string; deployedAt?: string };
  meta?: MetaResponse;
  /** Plan/limit facts observed while provisioning (free text, no identifiers). */
  observed?: Record<string, string>;
}

/* --------------------------------- pure --------------------------------- */

export function newStamp(now = Date.now()): string {
  return now.toString(36);
}

/** Every name the fixture uses, derived from the stamp. All carry PREFIX. */
export function names(stamp: string) {
  return {
    project: `${PREFIX}pg-${stamp}`,
    tursoGroup: TURSO_GROUP,
    tursoDb: `${PREFIX}td-${stamp}`,
    tursodbDb: `${PREFIX}tdb-${stamp}`,
    d1: `${PREFIX}d1-${stamp}`,
    hdNocache: `${PREFIX}hd-nc-${stamp}`,
    hdCached: `${PREFIX}hd-c-${stamp}`,
    worker: `${PREFIX}probe-${stamp}`,
  };
}

export function emptyFixture(stamp = newStamp()): Fixture {
  const t = new Date().toISOString();
  return { version: 1, stamp, createdAt: t, updatedAt: t };
}

/** Parse and sanity-check a .fixture.json body; throws on a wrong shape. */
export function parseFixture(text: string): Fixture {
  const f = JSON.parse(text) as Fixture;
  if (f?.version !== 1 || typeof f.stamp !== "string" || !f.stamp) throw new Error(".fixture.json: version 1 with a stamp expected");
  const all = [f.supabase?.name, f.turso?.db, f.turso?.group, f.tursodb?.db, f.d1?.name, f.hyperdrive?.nocache?.name, f.hyperdrive?.cached?.name, f.worker?.name];
  for (const n of all) if (n !== undefined && !n.startsWith(PREFIX)) throw new Error(`.fixture.json names a resource without the ${PREFIX} prefix: ${n}`);
  return f;
}

export function isComplete(f: Fixture): boolean {
  return !!(f.supabase?.readyMs !== undefined && f.supabase.secretKey && f.turso?.token && f.d1?.id && f.hyperdrive?.nocache && f.hyperdrive?.cached && f.worker?.deployedAt);
}

export function workerUrl(name: string, subdomain: string): string {
  return `https://${name}.${subdomain}.workers.dev`;
}

export function renderWrangler(f: Fixture, drivers: { pg: string; libsql: string }): Record<string, unknown> {
  if (!f.worker || !f.d1 || !f.hyperdrive?.nocache || !f.hyperdrive.cached || !f.supabase || !f.turso) throw new Error("renderWrangler: fixture incomplete");
  return {
    $comment: "Rendered by lib/fixture.ts up. Gitignored: it names the fixture's resources.",
    name: f.worker.name,
    main: "worker/index.ts",
    compatibility_date: f.worker.compatDate,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    d1_databases: [{ binding: "DB", database_name: f.d1.name, database_id: f.d1.id }],
    hyperdrive: [
      { binding: "HD", id: f.hyperdrive.nocache.id },
      { binding: "HD_CACHED", id: f.hyperdrive.cached.id },
    ],
    durable_objects: { bindings: [{ name: "PDO", class_name: "ProbeDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ProbeDO"] }],
    vars: {
      SUPABASE_URL: f.supabase.url,
      TURSO_URL: f.turso.url,
      TURSODB_URL: f.tursodb?.url ?? "",
      DRIVER_PG: drivers.pg,
      DRIVER_LIBSQL: drivers.libsql,
      COMPAT_DATE: f.worker.compatDate,
    },
  };
}

/** The Worker's secrets, as the JSON `wrangler secret bulk` reads on stdin. */
export function workerSecrets(f: Fixture): Record<string, string> {
  if (!f.worker?.probeKey || !f.turso?.token || !f.supabase?.secretKey) throw new Error("workerSecrets: fixture incomplete");
  return { PROBE_KEY: f.worker.probeKey, TURSO_TOKEN: f.turso.token, TURSODB_TOKEN: f.tursodb?.token ?? "unset", SUPABASE_SECRET_KEY: f.supabase.secretKey };
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Environment for `make probe` (non-secret identifiers only; modules read
 * secrets from the fixture file through lib/client.ts loadFixture).
 */
export function exportsFor(f: Fixture, file = FIXTURE_FILE, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const e: Record<string, string> = { PVLAB_ENDPOINT_FIXTURE: file };
  if (f.worker?.url) e.PVLAB_ENDPOINT_PROBE = f.worker.url;
  if (f.supabase) {
    e.PVLAB_REF = f.supabase.ref;
    e.PVLAB_PEER_SUPABASE = f.supabase.ref;
    e.PVLAB_ENDPOINT_SUPABASE_URL = f.supabase.url;
    e.PVLAB_ENDPOINT_DIRECT = f.supabase.directHost;
    if (f.supabase.poolerHost) e.PVLAB_ENDPOINT_POOLER = f.supabase.poolerHost;
  }
  if (f.turso) {
    e.PVLAB_PEER_TURSO_DB = f.turso.db;
    e.PVLAB_PEER_TURSO_GROUP = f.turso.group;
    e.PVLAB_ENDPOINT_TURSO_URL = f.turso.url;
    e.PVLAB_ORG_TURSO = f.turso.org;
  }
  if (f.tursodb?.url) e.PVLAB_PEER_TURSODB_DB = f.tursodb.db;
  if (f.d1) {
    e.PVLAB_PEER_D1 = f.d1.id;
    e.PVLAB_PEER_D1_NAME = f.d1.name;
  }
  if (f.hyperdrive?.nocache) e.PVLAB_PEER_HD_NOCACHE = f.hyperdrive.nocache.id;
  if (f.hyperdrive?.cached) e.PVLAB_PEER_HD_CACHED = f.hyperdrive.cached.id;
  if (env.PVLAB_ORG_PRO) e.PVLAB_ORG_PRO = env.PVLAB_ORG_PRO;
  return e;
}

export function exportLines(e: Record<string, string>): string {
  return Object.entries(e)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join("\n");
}

/** Identifiers a published artifact must not carry (refs are shape-redacted anyway). */
export function literalsOf(f: Partial<Fixture>, env: Record<string, string | undefined> = process.env): string[] {
  const out = [
    f.supabase?.ref,
    f.supabase?.org,
    f.supabase?.poolerHost,
    f.turso?.org,
    f.turso?.hostname,
    f.tursodb?.hostname,
    f.d1?.id,
    f.hyperdrive?.nocache?.id,
    f.hyperdrive?.cached?.id,
    f.worker?.url?.replace(/^https:\/\//, ""),
    env.CLOUDFLARE_ACCOUNT_ID,
    env.PVLAB_TURSO_ORG,
    env.PVLAB_ORG_PRO,
  ];
  return [...new Set(out.filter((x): x is string => typeof x === "string" && x.length >= 6))];
}

/** The identifier-only record `down` archives to evidence/ for later redaction. */
export function idsOnly(f: Fixture): Partial<Fixture> {
  return {
    version: 1,
    stamp: f.stamp,
    createdAt: f.createdAt,
    ...(f.supabase ? { supabase: { ...f.supabase, dbPass: "", secretKey: undefined, anonKey: undefined, serviceKey: undefined, publishableKey: undefined } } : {}),
    ...(f.turso ? { turso: { ...f.turso, token: undefined } } : {}),
    ...(f.tursodb ? { tursodb: { ...f.tursodb, token: undefined } } : {}),
    ...(f.d1 ? { d1: f.d1 } : {}),
    ...(f.hyperdrive ? { hyperdrive: f.hyperdrive } : {}),
    ...(f.worker ? { worker: { ...f.worker, probeKey: "" } } : {}),
  };
}

/* ------------------------------ fixture file ----------------------------- */

export async function readFixture(file = FIXTURE_FILE): Promise<Fixture | null> {
  try {
    return parseFixture(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeFixture(f: Fixture, file = FIXTURE_FILE): Promise<void> {
  f.updatedAt = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

const log = (m: string) => process.stderr.write(`[fixture ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

/** Strip anything identifying before an error string reaches the terminal. */
export function scrub(s: string, f?: Partial<Fixture>): string {
  let out = s
    .replace(/postgres(ql)?:\/\/[^\s"']+/g, "<conn>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b[0-9a-f]{32}\b/g, "<hex32>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "sb_$1_<key>")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~");
  for (const l of f ? literalsOf(f) : literalsOf({})) out = out.split(l).join("<id>");
  return out;
}

/* ------------------------------- Supabase ------------------------------- */

async function mgmtRetry(ctx: Ctx, method: string, path: string, body?: unknown) {
  let r = await mgmt(ctx, method, path, body);
  for (let i = 0; i < 6 && (r.status === 429 || r.throttled); i++) {
    await sleep(15_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

async function supabaseCreate(ctx: Ctx, f: Fixture, org: string): Promise<void> {
  const n = names(f.stamp);
  const dbPass = `${crypto.randomUUID()}Aa1!`;
  const r = await mgmtRetry(ctx, "POST", "/projects", {
    organization_slug: org,
    name: n.project,
    db_pass: dbPass,
    region: SUPABASE_REGION,
    desired_instance_size: "micro",
  });
  const ref = String((r.json as { ref?: string; id?: string } | undefined)?.ref ?? (r.json as { id?: string } | undefined)?.id ?? "");
  if (r.status !== 201 || !ref) throw new Error(`create project: HTTP ${r.status} ${scrub(r.text.slice(0, 300))}`);
  f.supabase = { name: n.project, ref, region: SUPABASE_REGION, org, dbPass, url: `https://${ref}.supabase.co`, directHost: `db.${ref}.supabase.co` };
  log(`supabase: created ${n.project} (${SUPABASE_REGION}, micro)`);
}

/**
 * The direct host is IPv6-only (AAAA, no A). On the macOS vantage getaddrinfo
 * (dns.lookup, which pg uses) answered ENOTFOUND for it while resolve6
 * returned the AAAA record (2026-10-15), so local direct connections go to the
 * resolved address. TLS is unverified anyway (rejectUnauthorized false).
 */
export async function directAddress(host: string): Promise<string> {
  const v6 = await resolve6(host).catch(() => [] as string[]);
  if (!v6[0]) throw new Error("direct host: no AAAA record");
  return v6[0];
}

async function pgOnce(cfg: pg.ClientConfig): Promise<string> {
  const c = new pg.Client({ ...cfg, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  try {
    await c.connect();
    await c.query("select 1");
    return "ok";
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function until(what: string, tries: number, gapMs: number, fn: () => Promise<boolean>): Promise<{ ok: boolean; tries: number; last: string }> {
  let last = "";
  for (let i = 1; i <= tries; i++) {
    try {
      if (await fn()) return { ok: true, tries: i, last: "" };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (i < tries) await sleep(gapMs);
  }
  log(`${what}: not ready after ${tries} tries: ${scrub(last).slice(0, 200)}`);
  return { ok: false, tries, last };
}

async function supabaseReady(ctx: Ctx, f: Fixture): Promise<void> {
  const s = f.supabase!;
  const t0 = Date.parse(f.createdAt);
  const pc: Ctx = { ...ctx, ref: s.ref, apiHost: `${s.ref}.supabase.co`, phzHost: s.directHost, dbPassword: s.dbPass, region: SUPABASE_REGION };
  if (s.healthyMs === undefined) {
    let status = "";
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
      await sleep(10_000);
      const g = await mgmt(ctx, "GET", `/projects/${s.ref}`);
      status = String((g.json as { status?: string } | undefined)?.status ?? status);
    }
    if (status !== "ACTIVE_HEALTHY") throw new Error(`project not ACTIVE_HEALTHY after 20 min (last: ${status})`);
    s.healthyMs = Date.now() - t0;
    log(`supabase: ACTIVE_HEALTHY after ${Math.round(s.healthyMs / 1000)} s`);
  }
  const readiness: Record<string, string> = {};
  const h = await until("health db/rest/auth", 36, 5_000, async () => {
    const r = await mgmt(ctx, "GET", `/projects/${s.ref}/health?services=db&services=rest&services=auth`);
    const rows = Array.isArray(r.json) ? (r.json as { healthy?: boolean; status?: string }[]) : [];
    return rows.length >= 3 && rows.every((x) => x.healthy === true || x.status === "ACTIVE_HEALTHY");
  });
  readiness.health = h.ok ? `ok after ${h.tries}` : "not healthy";
  const keys = await fetchKeys(pc);
  s.anonKey = keys.anon;
  s.serviceKey = keys.service;
  s.secretKey = keys.secret;
  s.publishableKey = keys.publishable;
  if (!s.secretKey) throw new Error("no sb_secret_ key on the project");
  const pr = await mgmtRetry(ctx, "GET", `/projects/${s.ref}/config/database/pooler`);
  const arr = Array.isArray(pr.json) ? (pr.json as Record<string, unknown>[]) : [];
  const e = arr.find((x) => x.database_type === "PRIMARY") ?? arr[0];
  s.poolerHost = String(e?.db_host ?? "");
  s.poolerUser = String(e?.db_user ?? `postgres.${s.ref}`);
  if (!s.poolerHost) throw new Error(`pooler config unreadable (HTTP ${pr.status})`);
  const q = await until("management SQL", 24, 5_000, async () => (await platformSql(pc, "select 1")).status < 300);
  readiness.mgmt_sql = q.ok ? `ok after ${q.tries}` : "failed";
  const pool = await until("pooler 6543", 36, 5_000, async () => (await pgOnce({ host: s.poolerHost, port: 6543, user: s.poolerUser, password: s.dbPass, database: "postgres" })) === "ok");
  readiness.pooler_tx = pool.ok ? `ok after ${pool.tries}` : `failed: ${scrub(pool.last).slice(0, 120)}`;
  const direct = await until("direct 5432", 36, 5_000, async () => (await pgOnce({ host: await directAddress(s.directHost), port: 5432, user: "postgres", password: s.dbPass, database: "postgres" })) === "ok");
  readiness.direct = direct.ok ? `ok after ${direct.tries}` : `failed: ${scrub(direct.last).slice(0, 120)}`;
  const rest = await until("postgrest", 36, 5_000, async () => {
    const r = await fetch(`${s.url}/rest/v1/`, { headers: { apikey: s.secretKey! }, signal: AbortSignal.timeout(15_000) });
    await r.body?.cancel();
    return r.status === 200;
  });
  readiness.postgrest = rest.ok ? `ok after ${rest.tries}` : "failed";
  s.readiness = readiness;
  // The pooler and PostgREST are what modules use; the direct host only has
  // to work from Hyperdrive (checked by its create) and is a local row.
  if (!pool.ok || !rest.ok || !q.ok) throw new Error(`supabase not ready: ${JSON.stringify(readiness)}`);
  s.readyMs = Date.now() - t0;
  log(`supabase: ready after ${Math.round(s.readyMs / 1000)} s (${JSON.stringify(readiness)})`);
}

/* --------------------------------- Turso -------------------------------- */

async function tursoUp(t: TursoCreds, f: Fixture): Promise<void> {
  const n = names(f.stamp);
  if (!f.turso) {
    const existing = await listTurso(t);
    let groupCreated = false;
    if (!existing.groups.includes(n.tursoGroup)) {
      groupCreated = (await createTursoGroup(t, n.tursoGroup, TURSO_LOCATION)) === "created";
      log(`turso: group ${n.tursoGroup} ${groupCreated ? "created" : "already there"} (${TURSO_LOCATION})`);
    }
    const db = await createTursoDb(t, n.tursoDb, n.tursoGroup);
    f.turso = { org: t.org, group: n.tursoGroup, groupCreated, location: TURSO_LOCATION, db: n.tursoDb, hostname: db.hostname, url: `https://${db.hostname}` };
    await writeFixture(f);
    log(`turso: database ${n.tursoDb} created`);
  }
  if (!f.turso.token) {
    f.turso.token = await tursoDbToken(t, f.turso.db);
    await writeFixture(f);
  }
  const ok = await until("turso pipeline", 24, 5_000, async () => {
    const r = await fetch(`${f.turso!.url}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.turso!.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "select 1" } }, { type: "close" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    await r.body?.cancel();
    return r.status === 200;
  });
  if (!ok.ok) throw new Error("turso database does not answer /v2/pipeline");
  log("turso: database answers");
}

/**
 * Turso-engine database next to the libSQL one (same group). An org that has
 * not enabled tursodb answers HTTP 400; that is recorded, not fatal, and the
 * Worker's tursodb backend then reports "not configured".
 */
async function tursodbUp(t: TursoCreds, f: Fixture): Promise<void> {
  const n = names(f.stamp);
  if (!f.tursodb?.url) {
    const t0 = Date.now();
    try {
      const db = await createTursoDb(t, n.tursodbDb, f.turso!.group, true);
      f.tursodb = { db: n.tursodbDb, hostname: db.hostname, url: `https://${db.hostname}`, dbId: db.dbId, createMs: Date.now() - t0 };
      log(`tursodb: database ${n.tursodbDb} created in ${f.tursodb.createMs} ms`);
    } catch (e) {
      f.tursodb = { db: n.tursodbDb, error: scrub(e instanceof Error ? e.message : String(e), f).slice(0, 300) };
      log(`tursodb: not created (${f.tursodb.error})`);
    }
    await writeFixture(f);
  }
  if (!f.tursodb.url) return;
  if (!f.tursodb.token) {
    f.tursodb.token = await tursoDbToken(t, f.tursodb.db);
    await writeFixture(f);
  }
  const ok = await until("tursodb pipeline", 24, 5_000, async () => {
    const r = await fetch(`${f.tursodb!.url}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.tursodb!.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "select 1" } }, { type: "close" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    await r.body?.cancel();
    return r.status === 200;
  });
  if (!ok.ok) throw new Error("tursodb database does not answer /v2/pipeline");
  log("tursodb: database answers");
}

/* ------------------------------ Cloudflare ------------------------------ */

async function d1Up(c: CfCreds, f: Fixture): Promise<void> {
  const n = names(f.stamp);
  if (!f.d1) {
    const r = await createD1(c, n.d1, D1_LOCATION_HINT);
    const info: Record<string, unknown> = {};
    for (const k of ["created_in_region", "primary_location_hint", "version", "read_replication"]) if (r.raw[k] !== undefined) info[k] = r.raw[k];
    f.d1 = { name: n.d1, id: r.id, locationHint: D1_LOCATION_HINT, createInfo: info };
    await writeFixture(f);
    log(`d1: ${n.d1} created (hint ${D1_LOCATION_HINT}; ${JSON.stringify(info)})`);
  }
  const q = await d1Rest(c, f.d1.id, "select 1 as one");
  if (!q.success) throw new Error(`d1 REST select 1: HTTP ${q.status}`);
  const meta = q.result?.[0]?.meta ?? {};
  f.observed = { ...(f.observed ?? {}), d1_rest_served_by_region: String(meta.served_by_region ?? "?"), d1_rest_served_by_primary: String(meta.served_by_primary ?? "?") };
}

async function hyperdriveUp(c: CfCreds, f: Fixture): Promise<void> {
  const n = names(f.stamp);
  const s = f.supabase!;
  const origin = { host: s.directHost, port: 5432, database: "postgres", user: "postgres", password: s.dbPass };
  f.hyperdrive ??= {};
  for (const [slot, name, disabled] of [["nocache", n.hdNocache, true], ["cached", n.hdCached, false]] as const) {
    if (f.hyperdrive[slot]) continue;
    let last = "";
    for (let i = 0; i < 8 && !f.hyperdrive[slot]; i++) {
      const r = await createHyperdrive(c, name, origin, disabled).catch((e: unknown) => ({ error: `fetch: ${e instanceof Error ? e.message : String(e)}` }));
      if ("id" in r) f.hyperdrive[slot] = { name, id: r.id };
      else {
        last = r.error;
        // a config may have been saved despite an error answer (timeout); adopt it
        log(`hyperdrive: ${name} attempt ${i + 1}: ${scrub(r.error, f).slice(0, 160)}`);
        const found = (await listHyperdrive(c).catch(() => [])).find((h) => h.name === name);
        if (found) f.hyperdrive[slot] = found;
        else await sleep(20_000);
      }
    }
    if (!f.hyperdrive[slot]) throw new Error(`hyperdrive ${slot}: ${scrub(last, f).slice(0, 300)}`);
    await writeFixture(f);
    log(`hyperdrive: ${name} (caching ${disabled ? "disabled" : "enabled"}) saved`);
  }
}

async function driverVersions(): Promise<{ pg: string; libsql: string }> {
  const v = async (p: string) => {
    try {
      return String(JSON.parse(await readFile(resolve(ROOT, "node_modules", p, "package.json"), "utf8")).version);
    } catch {
      return "?";
    }
  };
  return { pg: await v("pg"), libsql: await v("@libsql/client") };
}

function wranglerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The Global API Key trio is what logs in on this box; a stray token would win.
  delete env.CLOUDFLARE_API_TOKEN;
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}

function wrangler(args: string[], stdin?: string): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn("wrangler", args, { cwd: EXP_DIR, env: wranglerEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code: code ?? 1, out }));
    p.on("error", (e) => res({ code: 1, out: String(e) }));
    if (stdin !== undefined) p.stdin.write(stdin);
    p.stdin.end();
  });
}

export async function probeMeta(f: Fixture, timeoutMs = 60_000): Promise<MetaResponse> {
  const r = await fetch(`${f.worker!.url}/meta`, { headers: { "X-Probe-Key": f.worker!.probeKey }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  try {
    return JSON.parse(text) as MetaResponse;
  } catch {
    throw new Error(`/meta HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

async function workerUp(c: CfCreds, f: Fixture): Promise<void> {
  const n = names(f.stamp);
  if (!f.worker) {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    f.worker = { name: n.worker, url: workerUrl(n.worker, await workersSubdomain(c)), probeKey: key, compatDate: COMPAT_DATE };
    await writeFixture(f);
  }
  const drivers = await driverVersions();
  await writeFile(WRANGLER_FILE, `${JSON.stringify(renderWrangler(f, drivers), null, 2)}\n`);
  const d = await wrangler(["deploy", "--config", "wrangler.jsonc"]);
  if (d.code !== 0) throw new Error(`wrangler deploy exit ${d.code}: ${scrub(d.out, f).slice(-800)}`);
  const s = await wrangler(["secret", "bulk", "--config", "wrangler.jsonc"], JSON.stringify(workerSecrets(f)));
  if (s.code !== 0) throw new Error(`wrangler secret bulk exit ${s.code}: ${scrub(s.out, f).slice(-500)}`);
  f.worker.deployedAt = new Date().toISOString();
  await writeFixture(f);
  log(`worker: ${n.worker} deployed (pg ${drivers.pg}, @libsql/client ${drivers.libsql}, compat ${COMPAT_DATE})`);
  let m: MetaResponse | undefined;
  for (let i = 0; i < 24; i++) {
    try {
      m = await probeMeta(f);
      if (m.ok) break;
    } catch (e) {
      log(`worker: /meta not answering yet (${scrub(String(e), f).slice(0, 120)})`);
    }
    await sleep(5_000);
  }
  if (m) f.meta = m;
  await writeFixture(f);
  if (!m?.ok) throw new Error(`/meta not all-ok: ${scrub(JSON.stringify(m?.backends ?? {}), f).slice(0, 600)}`);
  log(`worker: /meta all backends ok from colo ${m.colo}`);
}

/* --------------------------------- verbs -------------------------------- */

interface Env {
  ctx: Ctx;
  org: string;
  c: CfCreds;
  t: TursoCreds;
}

export function missingEnv(env: Record<string, string | undefined> = process.env): string[] {
  const need = ["SUPABASE_ACCESS_TOKEN", "PVLAB_ORG_PRO", "CLOUDFLARE_EMAIL", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "TURSO_API_TOKEN", "PVLAB_TURSO_ORG"];
  return need.filter((k) => !env[k]);
}

async function vendorEnv(): Promise<Env> {
  const miss = missingEnv();
  if (miss.length) throw new Error(`missing env: ${miss.join(", ")} (inject with sx; see the Makefile header)`);
  const ctx = await buildCtx({ where: "local", quiet: true });
  return { ctx, org: process.env.PVLAB_ORG_PRO!, c: cfCreds()!, t: tursoCreds()! };
}

export async function up(): Promise<Fixture> {
  const v = await vendorEnv();
  await mkdir(EXP_DIR, { recursive: true });
  const f = (await readFixture()) ?? emptyFixture();
  await writeFixture(f);
  log(`up: stamp ${f.stamp}${f.supabase ? " (resuming)" : ""}`);
  if (!f.supabase) {
    await supabaseCreate(v.ctx, f, v.org);
    await writeFixture(f);
  }
  await tursoUp(v.t, f);
  await tursodbUp(v.t, f);
  await d1Up(v.c, f);
  await writeFixture(f);
  if (f.supabase!.readyMs === undefined) {
    await supabaseReady(v.ctx, f);
    await writeFixture(f);
  }
  await hyperdriveUp(v.c, f);
  await workerUp(v.c, f);
  return f;
}

/** The deletes `down` performs, injectable for the idempotency test. */
export interface DownOps {
  worker(name: string): Promise<number>;
  hyperdrive(id: string): Promise<number>;
  d1(id: string): Promise<number>;
  tursoDb(name: string): Promise<number>;
  /** Delete the group only if it holds no databases; returns 0 when kept. */
  tursoGroup(name: string): Promise<number>;
  project(ref: string): Promise<number>;
}

export interface DownReport {
  steps: { what: string; name: string; status: number | string }[];
  ok: boolean;
}

/** Delete everything the fixture names, in dependency order. 404 counts as done. Never throws. */
export async function downWith(f: Fixture, ops: DownOps): Promise<DownReport> {
  const steps: DownReport["steps"] = [];
  const step = async (what: string, name: string, fn: () => Promise<number>) => {
    try {
      steps.push({ what, name, status: await fn() });
    } catch (e) {
      steps.push({ what, name, status: `error: ${scrub(e instanceof Error ? e.message : String(e), f).slice(0, 200)}` });
    }
  };
  if (f.worker) await step("worker", f.worker.name, () => ops.worker(f.worker!.name));
  for (const slot of ["nocache", "cached"] as const) {
    const h = f.hyperdrive?.[slot];
    if (h) await step(`hyperdrive ${slot}`, h.name, () => ops.hyperdrive(h.id));
  }
  if (f.d1) await step("d1", f.d1.name, () => ops.d1(f.d1!.id));
  if (f.turso) {
    await step("turso db", f.turso.db, () => ops.tursoDb(f.turso!.db));
    if (f.tursodb?.url) await step("tursodb db", f.tursodb.db, () => ops.tursoDb(f.tursodb!.db));
    await step("turso group", f.turso.group, () => ops.tursoGroup(f.turso!.group));
  }
  if (f.supabase) await step("supabase project", f.supabase.name, () => ops.project(f.supabase!.ref));
  const ok = steps.every((s) => typeof s.status === "number" && (goneOk(s.status) || s.status === 0));
  return { steps, ok };
}

function realDownOps(v: Env): DownOps {
  return {
    worker: (n) => deleteWorker(v.c, n),
    hyperdrive: (id) => deleteHyperdrive(v.c, id),
    d1: (id) => deleteD1(v.c, id),
    tursoDb: (n) => deleteTursoDb(v.t, n),
    tursoGroup: async (n) => {
      const l = await listTurso(v.t);
      if (!l.groups.includes(n)) return 404;
      if (l.databases.some((d) => d.group === n)) return 0;
      return deleteTursoGroup(v.t, n);
    },
    project: (ref) => deleteSbProject(v.ctx, ref),
  };
}

export async function down(): Promise<DownReport> {
  const f = await readFixture();
  if (!f) {
    log("down: no .fixture.json; nothing to delete (run `make cleanup` for leftovers)");
    return { steps: [], ok: true };
  }
  const v = await vendorEnv();
  const rep = await downWith(f, realDownOps(v));
  for (const s of rep.steps) log(`down: ${s.what} ${s.name}: ${s.status}`);
  await mkdir(resolve(EXP_DIR, "evidence"), { recursive: true });
  await writeFile(resolve(EXP_DIR, "evidence", `fixture-ids-${f.stamp}.json`), `${JSON.stringify(idsOnly(f), null, 2)}\n`, { mode: 0o600 });
  if (rep.ok) {
    await rm(FIXTURE_FILE, { force: true });
    await rm(WRANGLER_FILE, { force: true });
    log("down: done; .fixture.json removed (identifiers archived under evidence/ for publish-time redaction)");
  } else {
    log("down: some deletes failed; .fixture.json kept so `make down` can retry");
  }
  return rep;
}

export async function status(): Promise<void> {
  const f = await readFixture();
  if (!f) {
    console.log("no .fixture.json");
    return;
  }
  const v = await vendorEnv();
  const rows: [string, string, string][] = [];
  if (f.supabase) {
    const g = await mgmt(v.ctx, "GET", `/projects/${f.supabase.ref}`);
    rows.push(["supabase project", f.supabase.name, g.status === 200 ? String((g.json as { status?: string }).status) : `HTTP ${g.status}`]);
  }
  if (f.turso) {
    const l = await listTurso(v.t);
    rows.push(["turso group", f.turso.group, l.groups.includes(f.turso.group) ? "exists" : "absent"]);
    rows.push(["turso db", f.turso.db, l.databases.some((d) => d.name === f.turso!.db) ? "exists" : "absent"]);
  }
  if (f.d1) rows.push(["d1", f.d1.name, (await listD1(v.c)).some((d) => d.id === f.d1!.id) ? "exists" : "absent"]);
  const hds = await listHyperdrive(v.c);
  for (const slot of ["nocache", "cached"] as const) {
    const h = f.hyperdrive?.[slot];
    if (h) rows.push([`hyperdrive ${slot}`, h.name, hds.some((x) => x.id === h.id) ? "exists" : "absent"]);
  }
  if (f.worker) {
    const ws = await listWorkers(v.c);
    rows.push(["worker", f.worker.name, ws.some((w) => w.name === f.worker!.name) ? "exists" : "absent"]);
    try {
      const m = await probeMeta(f, 30_000);
      rows.push(["/meta", m.colo, Object.entries(m.backends).map(([b, r]) => `${b}=${r.ok ? "ok" : "FAIL"}`).join(" ")]);
    } catch (e) {
      rows.push(["/meta", "-", scrub(String(e), f).slice(0, 120)]);
    }
  }
  console.log(`stamp ${f.stamp}, complete: ${isComplete(f)}`);
  for (const r of rows) console.log(`${r[0].padEnd(18)} ${r[1].padEnd(24)} ${r[2]}`);
}

/** Every sec- resource on all three vendors, by name. */
export async function leftovers(v: Env) {
  const [projects, d1, hd, workers, t, dons] = await Promise.all([listSecProjects(v.ctx, v.org), listD1(v.c), listHyperdrive(v.c), listWorkers(v.c), listTurso(v.t), listDoNamespaces(v.c).catch((e) => [{ name: `${PREFIX}unlistable (${String(e).slice(0, 80)})`, id: "", className: "" }])]);
  return {
    projects,
    d1: secOnly(d1, (x) => x.name),
    hyperdrive: secOnly(hd, (x) => x.name),
    workers: secOnly(workers, (x) => x.name),
    doNamespaces: secOnly(dons, (x) => x.name),
    tursoDbs: secOnly(t.databases, (x) => x.name),
    tursoGroups: secOnly(t.groups, (x) => x),
  };
}

export async function cleanup(dry: boolean): Promise<number> {
  const v = await vendorEnv();
  const l = await leftovers(v);
  const say = (what: string, name: string, st: number | string) => console.log(`${dry ? "would delete" : "deleted"} ${what} ${name}${dry ? "" : ` -> ${st}`}`);
  const del = async (what: string, name: string, fn: () => Promise<number>) => {
    if (dry) return say(what, name, "");
    try {
      say(what, name, await fn());
    } catch (e) {
      say(what, name, `error: ${scrub(String(e)).slice(0, 160)}`);
    }
  };
  for (const w of l.workers) await del("worker", w.name, () => deleteWorker(v.c, w.name));
  for (const h of l.hyperdrive) await del("hyperdrive", h.name, () => deleteHyperdrive(v.c, h.id));
  for (const d of l.d1) await del("d1", d.name, () => deleteD1(v.c, d.id));
  for (const d of l.tursoDbs) await del("turso db", d.name, () => deleteTursoDb(v.t, d.name));
  for (const g of l.tursoGroups) await del("turso group", g, () => deleteTursoGroup(v.t, g));
  for (const p of l.projects) await del("supabase project", p.name, () => deleteSbProject(v.ctx, p.ref));
  const after = dry ? l : await leftovers(v);
  const counts = {
    supabase_projects: after.projects.length,
    cf_workers: after.workers.length,
    cf_d1: after.d1.length,
    cf_hyperdrive: after.hyperdrive.length,
    cf_do_namespaces: after.doNamespaces.length,
    turso_dbs: after.tursoDbs.length,
    turso_groups: after.tursoGroups.length,
  };
  console.log(`${PREFIX} resources ${dry ? "present" : "left"}: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  if (!dry && after.projects.some((p) => p.status === "REMOVED" || /GOING_AWAY|REMOV/i.test(p.status))) {
    console.log("(projects still listed as going away count as left until the platform drops them)");
  }
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

export async function literals(): Promise<string[]> {
  const out = new Set<string>(literalsOf({}));
  const f = await readFixture().catch(() => null);
  if (f) for (const l of literalsOf(f)) out.add(l);
  const glob = new Bun.Glob("evidence/fixture-ids-*.json");
  for await (const p of glob.scan({ cwd: EXP_DIR })) {
    try {
      for (const l of literalsOf(JSON.parse(await readFile(resolve(EXP_DIR, p), "utf8")) as Partial<Fixture>)) out.add(l);
    } catch {
      /* skip unreadable */
    }
  }
  return [...out];
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    switch (verb) {
      case "up": {
        const f = await up();
        console.log(`fixture up: stamp ${f.stamp}; /meta ${f.meta?.ok ? "all ok" : "NOT ok"} from colo ${f.meta?.colo ?? "?"}`);
        break;
      }
      case "down": {
        const r = await down();
        process.exit(r.ok ? 0 : 1);
        break;
      }
      case "status":
        await status();
        break;
      case "env": {
        const f = await readFixture();
        if (!f) {
          console.error("no .fixture.json: run `make up` first");
          process.exit(1);
        }
        console.log(exportLines(exportsFor(f)));
        break;
      }
      case "cleanup": {
        const left = await cleanup(rest.includes("--dry-run"));
        process.exit(rest.includes("--dry-run") || left === 0 ? 0 : 1);
        break;
      }
      case "literals":
        console.log((await literals()).join(","));
        break;
      default:
        console.error("usage: bun lib/fixture.ts up|down|status|env|cleanup [--dry-run]|literals");
        process.exit(2);
    }
  } catch (e) {
    const f = await readFixture().catch(() => null);
    console.error(`fixture ${verb}: ${scrub(e instanceof Error ? e.message : String(e), f ?? undefined)}`);
    process.exit(1);
  }
}
