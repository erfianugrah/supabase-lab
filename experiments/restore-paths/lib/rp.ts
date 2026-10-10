/**
 * Shared assembly for the restore-paths modules.
 *
 * Every module here provisions its own throwaway project, runs one restore
 * path against it, and deletes the project in `finally`. The pieces that are
 * the same for every path live here so the paths are measured the same way:
 * which credential the pooler accepts, whether Storage answers AND serves a
 * pre-restore object, whether the SQL surface is up, and a per-path outage
 * window from the sampler.
 *
 * Credentials: passwords are generated per run, held in memory, and never
 * logged or placed in `measurements`/`evidence`. A password verifier
 * fingerprint is recorded as at most 8 hex characters.
 */
import { Client } from "pg";
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { sampleDuring, type PathWindow, type Probe, type ProbeOutcome } from "../../../harness/src/sampler";
import type { Ctx } from "../../../harness/src/types";
import { authProbe, realtimeProbe, restProbe, storageProbe } from "../../platform-downtime/lib/probes";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
export const INTERVAL_MS = 1000;
export const SETTLE_MS = 5000;
export const AUTH_PATH = "/auth/v1/health";
const PG_TIMEOUT_MS = 6000;

export function randomPassword(): string {
  return `${crypto.randomUUID().replace(/-/g, "")}Aa1`;
}

/** Everything a module needs to talk to one throwaway project. */
export interface Subject {
  ctx: Ctx;
  ref: string;
  apiHost: string;
  anon: string;
  service: string;
  /** Pooler session-mode target, read off the platform. */
  pooler: { host: string; port: number; user: string };
  /** Whether the project has been deleted already. */
  deleted: boolean;
}

export async function waitProjectStatus(
  ctx: Ctx,
  ref: string,
  want: string,
  maxMs: number,
  pollMs = 10_000,
): Promise<{ ok: boolean; ms: number; last: string }> {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < maxMs) {
    const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
    if (p?.throttled || p?.status === 429) {
      await sleep(30_000);
      continue;
    }
    last = String((p?.json as { status?: string } | undefined)?.status ?? `HTTP ${p?.status}`);
    if (last === want) return { ok: true, ms: Date.now() - t0, last };
    await sleep(pollMs);
  }
  return { ok: false, ms: Date.now() - t0, last };
}

export async function createProject(
  ctx: Ctx,
  org: string,
  name: string,
  password: string,
  size?: string,
): Promise<{ ref: string; status: number; text: string; ms: number }> {
  const t0 = Date.now();
  const r = await mgmt(ctx, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: password,
    region_selection: { type: "specific", code: "ap-southeast-1" },
    ...(size ? { desired_instance_size: size } : {}),
  });
  const ref = String((r.json as { ref?: string; id?: string } | undefined)?.ref ?? (r.json as { id?: string } | undefined)?.id ?? "");
  return { ref, status: r.status, text: r.text.slice(0, 300), ms: Date.now() - t0 };
}

export async function deleteProject(ctx: Ctx, ref: string): Promise<number> {
  let r = await mgmt(ctx, "DELETE", `/projects/${ref}`);
  for (let i = 0; i < 3 && (r.status === 429 || r.throttled); i++) {
    await sleep(30_000);
    r = await mgmt(ctx, "DELETE", `/projects/${ref}`);
  }
  return r.status;
}

/** Build the per-project handle once the project is ACTIVE_HEALTHY. */
export async function subjectOf(base: Ctx, ref: string): Promise<Subject> {
  const ctx: Ctx = { ...base, ref, phzHost: `db.${ref}.supabase.co`, apiHost: `${ref}.supabase.co` };
  const keys = await fetchKeys(ctx);
  const pr = await mgmt(ctx, "GET", `/projects/${ref}/config/database/pooler`);
  const arr = Array.isArray(pr.json) ? (pr.json as Array<Record<string, unknown>>) : [];
  const e = arr.find((x) => x.database_type === "PRIMARY") ?? arr[0] ?? {};
  const host = String(e.db_host ?? "");
  const user = String(e.db_user ?? `postgres.${ref}`);
  if (!host) throw new Error(`pooler config unreadable (HTTP ${pr.status})`);
  return { ctx, ref, apiHost: ctx.apiHost, anon: keys.anon, service: keys.service, pooler: { host, port: 5432, user }, deleted: false };
}

/* ---------- credential checks ---------- */

export interface Login {
  ok: boolean;
  /** Postgres error text when it failed, verbatim (no password in it). */
  error: string;
  /** True when the server answered the auth attempt, even to refuse it. */
  answered: boolean;
  /**
   * The pooler's circuit breaker refused the attempt before checking the
   * password ("too many authentication failures, new connections are
   * temporarily blocked"). The credential question is unanswered, not failed.
   */
  blocked: boolean;
}

const AUTH_REFUSED = /password authentication failed|SASL|authentication failed|no pg_hba/i;
const BREAKER = /ECIRCUITBREAKER|too many authentication failures/i;

/** One login through the pooler's session port with a given password. */
export async function poolerLogin(s: Subject, password: string): Promise<Login> {
  const c = new Client({
    host: s.pooler.host,
    port: s.pooler.port,
    user: s.pooler.user,
    database: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: PG_TIMEOUT_MS,
  });
  c.on("error", () => {});
  try {
    await c.connect();
    await c.query("select 1");
    return { ok: true, error: "", answered: true, blocked: false };
  } catch (e) {
    const t = errText(e);
    return { ok: false, error: t, answered: AUTH_REFUSED.test(t), blocked: BREAKER.test(t) };
  } finally {
    await c.end().catch(() => {});
  }
}

/** Direct 5432 on db.<ref>.supabase.co. IPv6-only, so unreachable from an IPv4-only vantage. */
export async function directLogin(s: Subject, password: string): Promise<Login> {
  const c = new Client({
    host: s.ctx.phzHost,
    port: 5432,
    user: "postgres",
    database: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: PG_TIMEOUT_MS,
  });
  c.on("error", () => {});
  try {
    await c.connect();
    await c.query("select 1");
    return { ok: true, error: "", answered: true, blocked: false };
  } catch (e) {
    const t = errText(e);
    return { ok: false, error: t, answered: AUTH_REFUSED.test(t), blocked: BREAKER.test(t) };
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * Login that waits out the pooler's circuit breaker: retried every 15 s while
 * the answer is "blocked", up to `maxMs`. Returns the final login and how long
 * the breaker held it, so the breaker's duration is itself recorded.
 */
export async function settledLogin(s: Subject, password: string, maxMs = 5 * 60_000): Promise<Login & { blockedS: number }> {
  const t0 = Date.now();
  let r = await poolerLogin(s, password);
  while (r.blocked && Date.now() - t0 < maxMs) {
    await sleep(15_000);
    r = await poolerLogin(s, password);
  }
  return { ...r, blockedS: Math.round((Date.now() - t0) / 1000) };
}

export function serviceProbes(s: Subject): Probe[] {
  return [
    restProbe(s.apiHost, s.anon),
    authProbe(s.apiHost, s.anon, AUTH_PATH),
    storageProbe(s.apiHost, s.anon),
    realtimeProbe(s.apiHost, s.anon),
  ];
}

export interface CredentialWatch {
  /** Sampler probe for the pooler path, fed by the watch's own logins (no extra connections). */
  probe: Probe;
  stop(): Promise<CredentialTimeline>;
}
/**
 * ok: logged in. refused: the server answered and rejected the password
 * ("password authentication failed"). blocked: the pooler's circuit breaker
 * answered before checking. down: no answer (connection refused, starting up,
 * not accepting connections, timeout).
 */
export type CredState = "ok" | "refused" | "blocked" | "down";
export interface CredentialTimeline {
  /** "t+12s new=ok old=refused" lines, one per state change. */
  transitions: string[];
  firstOkNewS: number | "never";
  firstOkOldS: number | "never";
  /** First time the current password was refused after the watch began, or "never". */
  firstRefusedNewS: number | "never";
  /** Seconds from the first refusal of the current password to its first later success. */
  refusedUntilOkS: number | "never";
  finalNew: CredState;
  finalOld: CredState;
  /** Verbatim failure texts seen for the new password, first-seen order. */
  newFailModes: string[];
  oldFailModes: string[];
}

const stateOf = (l: Login): CredState => (l.ok ? "ok" : l.blocked ? "blocked" : l.answered ? "refused" : "down");

/**
 * Poll the pooler with BOTH passwords from now until stop(): `newPw` is the
 * credential current at the moment the restore was issued, `oldPw` the one it
 * replaced. A restore that rolls pg_authid back to a pre-rotation snapshot
 * makes `old` work and `new` refused; a resync makes `new` work again, and the
 * span between the two is the stale-credential window.
 *
 * Cadence is set by the pooler's circuit breaker: the first RP02 run polled
 * both passwords every 4 s plus a 1 s pooler probe, and within a minute the
 * pooler answered every login with "(ECIRCUITBREAKER) too many authentication
 * failures, new connections are temporarily blocked", before the password was
 * even checked. So `new` is polled every 5 s; once refused it stays at 5 s for
 * 60 s (to resolve a short stale window) and then drops to 20 s; `old` (known
 * wrong in the normal case) once a minute. Only state changes are recorded. The
 * pooler path's sampler probe reads this loop's latest `new` outcome (an
 * answered refusal counts as the path being up), so there is one login stream.
 */
export function watchCredentials(s: Subject, newPw: string, oldPw: string): CredentialWatch {
  const t0 = Date.now();
  let running = true;
  const transitions: string[] = [];
  let prev = "";
  let firstNew: number | "never" = "never";
  let firstOld: number | "never" = "never";
  let firstRefused: number | "never" = "never";
  let refusedUntilOk: number | "never" = "never";
  let lastNew: CredState = "ok";
  let lastOld: CredState = "refused";
  const newModes: string[] = [];
  const oldModes: string[] = [];
  let latest: ProbeOutcome = { ok: true };
  let lastOldAt = 0;
  let refusedSince = 0;
  const note = () => {
    const at = Math.round((Date.now() - t0) / 1000);
    const state = `new=${lastNew} old=${lastOld}`;
    if (state !== prev) {
      transitions.push(`t+${at}s ${state}`);
      prev = state;
    }
    return at;
  };
  const loop = (async () => {
    while (running) {
      const n = await poolerLogin(s, newPw);
      lastNew = stateOf(n);
      latest = n.ok || (n.answered && !n.blocked) ? { ok: true } : { ok: false, error: n.error };
      if (!n.ok && !newModes.includes(n.error)) newModes.push(n.error);
      let at = note();
      if (n.ok && firstNew === "never") firstNew = at;
      if (lastNew === "refused") {
        if (firstRefused === "never") firstRefused = at;
        if (!refusedSince) refusedSince = Date.now();
      } else if (n.ok && firstRefused !== "never" && refusedUntilOk === "never") {
        refusedUntilOk = at - firstRefused;
      }
      if (lastNew !== "refused") refusedSince = 0;
      if (lastOldAt === 0 || Date.now() - lastOldAt >= 60_000) {
        const o = await poolerLogin(s, oldPw);
        lastOldAt = Date.now();
        lastOld = stateOf(o);
        if (!o.ok && !oldModes.includes(o.error)) oldModes.push(o.error);
        at = note();
        if (o.ok && firstOld === "never") firstOld = at;
      }
      await sleep(lastNew === "refused" && refusedSince && Date.now() - refusedSince > 60_000 ? 20_000 : 5_000);
    }
  })();
  return {
    probe: { name: "pooler", run: async () => latest },
    async stop() {
      running = false;
      await loop;
      return {
        transitions,
        firstOkNewS: firstNew,
        firstOkOldS: firstOld,
        firstRefusedNewS: firstRefused,
        refusedUntilOkS: refusedUntilOk,
        finalNew: lastNew,
        finalOld: lastOld,
        newFailModes: newModes,
        oldFailModes: oldModes,
      };
    },
  };
}

/* ---------- data and Storage seeds ---------- */

const BUCKET = "rp-bucket";
const OBJECT = "rp-seed.txt";
export const OBJECT_BODY = "restore-paths seed object";

export async function seedData(s: Subject): Promise<string> {
  const r = await sql(
    s.ctx,
    "create table if not exists public.rp_marker (id serial primary key, label text not null, at timestamptz default now()); insert into public.rp_marker(label) values ('seed-before-backup')",
  );
  return r.status === 201 ? "ok" : `HTTP ${r.status} ${r.error}`;
}

/**
 * Grow the database to roughly `mb` megabytes with 500k-row batches of ~230 B
 * rows over the Management API SQL endpoint. Returns the size read back with
 * pg_database_size, so a restore time can be tied to a size that was measured.
 */
export async function seedBulk(s: Subject, mb: number): Promise<{ dbMb: number; batches: number; error: string }> {
  await sql(s.ctx, "create table if not exists public.rp_bulk (id bigserial primary key, pad text not null)");
  let batches = 0;
  let dbMb = await dbSizeMb(s);
  let error = "";
  while (dbMb < mb && batches < 40) {
    const r = await sql(s.ctx, "insert into public.rp_bulk(pad) select repeat(md5(random()::text), 7) from generate_series(1, 500000)", 120_000);
    batches += 1;
    if (r.status !== 201) {
      error = `HTTP ${r.status} ${r.error}`;
      break;
    }
    dbMb = await dbSizeMb(s);
  }
  return { dbMb, batches, error };
}

/** pg_wal size in MB (-1 if unreadable): unarchived WAL is what fills a PITR project's disk. */
export async function walMb(s: Subject): Promise<number> {
  const r = await sql(s.ctx, "select (coalesce(sum(size), 0) / 1048576)::int as mb from pg_ls_waldir()");
  return r.status === 201 && r.rows[0] ? Number(r.rows[0].mb) : -1;
}

/** Provisioned disk and utilisation as the platform reports them, one line. */
export async function diskLine(s: Subject): Promise<string> {
  const cfg = await mgmt(s.ctx, "GET", `/projects/${s.ref}/config/disk`);
  const util = await mgmt(s.ctx, "GET", `/projects/${s.ref}/config/disk/util`);
  const c = (cfg.json ?? {}) as { attributes?: { size_gb?: number; type?: string } };
  const u = (util.json ?? {}) as { metrics?: { fs_size_bytes?: number; fs_avail_bytes?: number; fs_used_bytes?: number } };
  const mb = (n?: number) => (n === undefined ? "?" : Math.round(n / 1048576));
  return `config HTTP ${cfg.status} size_gb=${c.attributes?.size_gb ?? "?"} type=${c.attributes?.type ?? "?"}; util HTTP ${util.status} fs_size_mb=${mb(u.metrics?.fs_size_bytes)} fs_avail_mb=${mb(u.metrics?.fs_avail_bytes)}`;
}

export async function dbSizeMb(s: Subject): Promise<number> {
  const r = await sql(s.ctx, "select (pg_database_size(current_database()) / 1048576)::int as mb");
  return r.status === 201 && r.rows[0] ? Number(r.rows[0].mb) : -1;
}

export async function markerLabels(s: Subject): Promise<string> {
  const r = await sql(s.ctx, "select label from public.rp_marker order by id");
  if (r.status !== 201) return `unreadable: HTTP ${r.status} ${r.error}`;
  return r.rows.map((x) => String(x.label)).join(",") || "(empty)";
}

export async function addMarker(s: Subject, label: string): Promise<string> {
  const r = await sql(s.ctx, `insert into public.rp_marker(label) values ('${label.replace(/[^a-z0-9_-]/gi, "")}')`);
  return r.status === 201 ? "ok" : `HTTP ${r.status} ${r.error}`;
}

/** md5 of the postgres role's stored verifier; 8 hex chars, enough to see it change. */
export async function verifierFingerprint(s: Subject): Promise<string> {
  const r = await sql(s.ctx, "select left(md5(rolpassword), 8) as f from pg_authid where rolname = 'postgres'");
  return r.status === 201 && r.rows[0] ? String(r.rows[0].f) : `unreadable: HTTP ${r.status} ${r.error}`.slice(0, 80);
}

function storageHeaders(s: Subject, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: s.service, Authorization: `Bearer ${s.service}`, ...extra };
}

async function st(s: Subject, method: string, path: string, body?: BodyInit, extra: Record<string, string> = {}) {
  try {
    const res = await fetch(`https://${s.apiHost}/storage/v1${path}`, {
      method,
      headers: storageHeaders(s, extra),
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, text: (await res.text()).slice(0, 4000) };
  } catch (e) {
    return { status: 0, text: errText(e) };
  }
}

export async function seedStorage(s: Subject): Promise<string> {
  const b = await st(s, "POST", "/bucket", JSON.stringify({ id: BUCKET, name: BUCKET, public: false }), { "Content-Type": "application/json" });
  const o = await st(s, "POST", `/object/${BUCKET}/${OBJECT}`, OBJECT_BODY, { "Content-Type": "text/plain" });
  return `bucket HTTP ${b.status}, object HTTP ${o.status}`;
}

export interface StorageState {
  /** One line, ready for a `measurements` cell. */
  line: string;
  allOk: boolean;
}

/**
 * Whether Storage answers AND serves what was stored before the restore:
 * list buckets, list objects, download the seed object and compare bytes, then
 * upload a new object. 5xx bodies are kept (truncated) because the failure
 * text is the finding.
 */
export async function storageState(s: Subject, tag: string): Promise<StorageState> {
  const buckets = await st(s, "GET", "/bucket");
  const list = await st(
    s,
    "POST",
    `/object/list/${BUCKET}`,
    JSON.stringify({ prefix: "", limit: 10 }),
    { "Content-Type": "application/json" },
  );
  const get = await st(s, "GET", `/object/${BUCKET}/${OBJECT}`);
  const put = await st(s, "POST", `/object/${BUCKET}/after-${tag}.txt`, `after ${tag}`, { "Content-Type": "text/plain", "x-upsert": "true" });
  const bytesMatch = get.status === 200 && get.text === OBJECT_BODY;
  const allOk = buckets.status === 200 && list.status === 200 && bytesMatch && put.status === 200;
  const bad = [buckets, list, get, put].find((x) => x.status >= 400 || x.status === 0);
  return {
    allOk,
    line:
      `buckets ${buckets.status}, list ${list.status}, get ${get.status}${get.status === 200 ? (bytesMatch ? " bytes-match" : " bytes-differ") : ""}, put ${put.status}` +
      (bad ? ` [${bad.text.slice(0, 80)}]` : ""),
  };
}

const POST_TARGET = "post-target.txt";

/** Upload an object that a restore to an earlier instant should roll back. */
export async function putPostTargetObject(s: Subject): Promise<string> {
  const r = await st(s, "POST", `/object/${BUCKET}/${POST_TARGET}`, "written after the restore target", { "Content-Type": "text/plain", "x-upsert": "true" });
  return `HTTP ${r.status}`;
}

/**
 * After a restore to an instant before `putPostTargetObject`: does Storage
 * still serve the object (file kept, metadata row gone or kept?), does the
 * bucket listing show it, and can the same path be written again without
 * `x-upsert`? One line; the mismatch between listing and download is the
 * finding if there is one.
 */
export async function postTargetState(s: Subject): Promise<string> {
  const get = await st(s, "GET", `/object/${BUCKET}/${POST_TARGET}`);
  const list = await st(s, "POST", `/object/list/${BUCKET}`, JSON.stringify({ prefix: "", limit: 100 }), { "Content-Type": "application/json" });
  const listed = list.status === 200 ? String(list.text.includes(POST_TARGET)) : "n/a";
  const put = await st(s, "POST", `/object/${BUCKET}/${POST_TARGET}`, "written again", { "Content-Type": "text/plain" });
  return `get ${get.status} [${get.text.slice(0, 60)}], listed ${listed}, re-put without upsert ${put.status} [${put.text.slice(0, 60)}]`;
}

/** `GET /health` per service, as the dashboard reads it. */
export async function healthLine(s: Subject): Promise<string> {
  const qs = ["auth", "db", "pooler", "realtime", "rest", "storage"].map((x) => `services=${x}`).join("&");
  const r = await mgmt(s.ctx, "GET", `/projects/${s.ref}/health?${qs}`, undefined, 15_000);
  const rows = Array.isArray(r.json) ? (r.json as { name?: string; status?: string }[]) : [];
  return rows.length ? rows.map((x) => `${x.name}=${x.status}`).join(" ") : `HTTP ${r.status}`;
}

export interface BackupView {
  walg: boolean;
  pitr: boolean;
  physicalIds: { id: number; at: string }[];
  windowEarliest: number | null;
  windowLatest: number | null;
  status: number;
}

export async function backups(s: Subject): Promise<BackupView> {
  const r = await mgmt(s.ctx, "GET", `/projects/${s.ref}/database/backups`);
  const j = (r.json ?? {}) as {
    walg_enabled?: boolean;
    pitr_enabled?: boolean;
    backups?: { id: number; is_physical_backup: boolean; status: string; inserted_at: string }[];
    physical_backup_data?: { earliest_physical_backup_date_unix?: number; latest_physical_backup_date_unix?: number };
  };
  return {
    walg: Boolean(j.walg_enabled),
    pitr: Boolean(j.pitr_enabled),
    physicalIds: (j.backups ?? []).filter((b) => b.is_physical_backup && b.status === "COMPLETED").map((b) => ({ id: b.id, at: b.inserted_at })),
    windowEarliest: j.physical_backup_data?.earliest_physical_backup_date_unix ?? null,
    windowLatest: j.physical_backup_data?.latest_physical_backup_date_unix ?? null,
    status: r.status,
  };
}

export async function setPassword(s: Subject, password: string): Promise<{ status: number; text: string }> {
  const r = await mgmt(s.ctx, "PATCH", `/projects/${s.ref}/database/password`, { password });
  return { status: r.status, text: r.text.slice(0, 160) };
}

/**
 * Flatten sampler windows to scalar report columns. `offsetMs` is how long
 * after sampling started the restore request was accepted, so `first_fail_s`
 * reads from the accepted request, not from the start of sampling.
 */
export function flatten(windows: PathWindow[], offsetMs = 0): Record<string, number | string> {
  const m: Record<string, number | string> = { probe_interval_ms: INTERVAL_MS };
  for (const w of windows) {
    m[`${w.name}_healthy_at_start`] = String(w.healthyAtStart);
    m[`${w.name}_first_fail_s`] = w.firstFailMs === null ? "n/a" : Math.round((w.firstFailMs - offsetMs) / 1000);
    m[`${w.name}_window_s`] = w.windowMs === null ? "n/a" : Math.round(w.windowMs / 1000);
    m[`${w.name}_mode`] = w.modes[0] ?? "none";
  }
  return m;
}

export function credentialColumns(prefix: string, t: CredentialTimeline): Record<string, number | string> {
  return {
    [`${prefix}_new_first_ok_s`]: t.firstOkNewS,
    [`${prefix}_old_first_ok_s`]: t.firstOkOldS,
    [`${prefix}_new_first_refused_s`]: t.firstRefusedNewS,
    [`${prefix}_new_refused_until_ok_s`]: t.refusedUntilOkS,
    [`${prefix}_final_new`]: t.finalNew,
    [`${prefix}_final_old`]: t.finalOld,
    [`${prefix}_transitions`]: t.transitions.join(" | ").slice(0, 400),
  };
}

/**
 * Poll project status through a restore: seconds from `t0` until the first
 * non-ACTIVE_HEALTHY status, the statuses seen in order, and seconds until
 * ACTIVE_HEALTHY again. Polls at 10 s, so these carry a 10 s resolution.
 */
export async function statusTimeline(
  ctx: Ctx,
  ref: string,
  t0: number,
  maxMs: number,
): Promise<{ firstOffS: number | "never"; backHealthyS: number | "never"; seen: string[] }> {
  const seen: string[] = [];
  let firstOff: number | "never" = "never";
  let back: number | "never" = "never";
  while (Date.now() - t0 < maxMs) {
    const p = await mgmt(ctx, "GET", `/projects/${ref}`).catch(() => undefined);
    if (p && !p.throttled && p.status === 200) {
      const st = String((p.json as { status?: string } | undefined)?.status ?? "?");
      if (seen[seen.length - 1] !== st) seen.push(st);
      const at = Math.round((Date.now() - t0) / 1000);
      if (st !== "ACTIVE_HEALTHY" && firstOff === "never") firstOff = at;
      if (st === "ACTIVE_HEALTHY" && firstOff !== "never") {
        back = at;
        break;
      }
    }
    await sleep(10_000);
  }
  return { firstOffS: firstOff, backHealthyS: back, seen };
}

export interface RestoreRun {
  windows: PathWindow[];
  /** Offset of the accepted request from the start of sampling. */
  postOffsetMs: number;
  http: number;
  body: string;
  /** One line per attempt: "<s> HTTP <status> <text>". */
  attempts: string[];
  acceptedAfterS: number | "never";
  tl: Awaited<ReturnType<typeof statusTimeline>> | undefined;
  cred: CredentialTimeline;
}

/**
 * One restore, measured: service paths under the sampler, both passwords
 * polled through the pooler, and the project status timeline. `issue` is
 * retried every `retryEveryMs` until it answers 2xx or `retryMs` runs out
 * (PITR refuses a target the archive has not caught up to). The sampler's
 * clock starts before the first attempt; `postOffsetMs` carries the gap.
 */
export async function measureRestore(
  s: Subject,
  o: {
    newPw: string;
    oldPw: string;
    issue: () => Promise<{ status: number; text: string }>;
    retryMs?: number;
    retryEveryMs?: number;
    maxMs?: number;
    tailMs?: number;
  },
): Promise<RestoreRun> {
  const maxMs = o.maxMs ?? 25 * 60_000;
  const tailMs = o.tailMs ?? 60_000;
  const retryMs = o.retryMs ?? 0;
  const retryEvery = o.retryEveryMs ?? 60_000;
  const watch = watchCredentials(s, o.newPw, o.oldPw);
  const probes = [...serviceProbes(s), watch.probe];
  const attempts: string[] = [];
  let http = 0;
  let body = "";
  let tl: RestoreRun["tl"];
  let cred: CredentialTimeline | undefined;
  let postOffsetMs = 0;
  let acceptedAfterS: number | "never" = "never";
  const tStart = Date.now();
  let refused = false;
  const windows = await sampleDuring(
    probes,
    { intervalMs: INTERVAL_MS, maxWaitMs: retryMs + maxMs + tailMs + 120_000, settleMs: SETTLE_MS, log: s.ctx.log },
    async () => {
      let r = await o.issue();
      attempts.push(`${Math.round((Date.now() - tStart) / 1000)}s HTTP ${r.status} ${r.text.slice(0, 120)}`);
      while ((r.status < 200 || r.status >= 300) && Date.now() - tStart < retryMs) {
        await sleep(retryEvery);
        r = await o.issue();
        attempts.push(`${Math.round((Date.now() - tStart) / 1000)}s HTTP ${r.status} ${r.text.slice(0, 120)}`);
      }
      http = r.status;
      body = r.text.slice(0, 200);
      const tPost = Date.now();
      postOffsetMs = tPost - tStart;
      if (r.status >= 200 && r.status < 300) {
        acceptedAfterS = Math.round(postOffsetMs / 1000);
        tl = await statusTimeline(s.ctx, s.ref, tPost, maxMs);
        await sleep(tailMs);
      } else {
        // Nothing to measure: end the sampler now instead of letting it wait
        // out maxWaitMs for a failure that cannot come.
        refused = true;
        cred = await watch.stop();
        throw new Error("restore request refused");
      }
      cred = await watch.stop();
    },
  ).catch((e: unknown) => {
    if (refused) return [] as PathWindow[];
    throw e;
  });
  return { windows, postOffsetMs, http, body, attempts, acceptedAfterS, tl, cred: cred as CredentialTimeline };
}
