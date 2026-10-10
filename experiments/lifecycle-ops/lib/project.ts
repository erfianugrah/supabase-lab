/**
 * Self-provisioning helpers shared by LO03-LO05: create with a region
 * fallback list, poll status transitions, delete, list-by-name.
 *
 * Every project made here is named `lo-<tag>-<run>`. Deletion and
 * listing only ever touch names that start with PREFIX, so a shared org's other
 * projects cannot be hit by a bad ref.
 */
import type { Ctx } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";

export const PREFIX = "lo-";
export const POLL_MS = 10_000;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One id per process, so names are unique per run and sweeps are scoped to it. */
export const RUN = Date.now().toString(36);
export const nameFor = (tag: string) => `${PREFIX}${tag}-${RUN}`;

export const strongPassword = () => `${crypto.randomUUID().replace(/-/g, "")}Aa1!`;

/**
 * Management API call that waits out a throttle (HTTP 429 or the Cloudflare
 * HTML interstitial) instead of recording it as a failure. Used for reads and
 * deletes; creates are NOT retried (an ambiguous POST is what LO04 studies).
 */
export async function mgmtPatient(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  tries = 4,
): Promise<MgmtResponse & { throttledTries: number }> {
  let throttledTries = 0;
  for (let i = 0; ; i++) {
    const r = await mgmt(ctx, method, path, body).catch(
      (e) => ({ status: 0, text: String(e), throttled: false }) as MgmtResponse,
    );
    if ((r.status === 429 || r.throttled) && i < tries) {
      throttledTries += 1;
      await sleep(15_000 * (i + 1));
      continue;
    }
    return { ...r, throttledTries };
  }
}

export interface CreateAttempt {
  region: string;
  http: number;
  ms: number;
  ref?: string;
  /** Verbatim response body, truncated. */
  body: string;
}

export interface CreateResult {
  ref: string | null;
  region: string | null;
  attempts: CreateAttempt[];
}

export function createBody(org: string, name: string, region: string, dbPass = strongPassword(), size = "micro") {
  return {
    organization_slug: org,
    name,
    db_pass: dbPass,
    region_selection: { type: "specific", code: region },
    desired_instance_size: size,
  };
}

/** POST /v1/projects walking `regions` in order until one returns 2xx with a ref. */
export async function createWithFallback(
  ctx: Ctx,
  org: string,
  name: string,
  regions: string[],
  dbPass = strongPassword(),
): Promise<CreateResult> {
  const attempts: CreateAttempt[] = [];
  for (const region of regions) {
    const t0 = Date.now();
    const r = await mgmt(ctx, "POST", "/projects", createBody(org, name, region, dbPass)).catch(
      (e) => ({ status: 0, text: String(e), throttled: false }) as MgmtResponse,
    );
    const ref = (r.json as { ref?: string; id?: string } | undefined)?.ref ?? undefined;
    attempts.push({ region, http: r.status, ms: Date.now() - t0, ref, body: r.text.slice(0, 300) });
    if (r.status >= 200 && r.status < 300 && ref) return { ref, region, attempts };
  }
  return { ref: null, region: null, attempts };
}

export interface Transition {
  /** ms since the poll started (the create call's return). */
  atMs: number;
  status: string;
}

/**
 * Poll GET /projects/{ref} every POLL_MS and record each distinct status in
 * order, until `want` or maxMs. A 404 or a non-JSON answer is recorded as
 * `HTTP <n>` so a transient control-plane gap is visible rather than skipped.
 */
export async function pollStatus(
  ctx: Ctx,
  ref: string,
  want: string,
  maxMs = 900_000,
  from = Date.now(),
): Promise<{ reached: boolean; ms: number; transitions: Transition[] }> {
  const transitions: Transition[] = [];
  for (;;) {
    const r = await mgmtPatient(ctx, "GET", `/projects/${ref}`);
    const s = r.status === 200 ? String((r.json as { status?: string } | undefined)?.status ?? "?") : `HTTP ${r.status}`;
    const last = transitions.at(-1);
    if (!last || last.status !== s) transitions.push({ atMs: Date.now() - from, status: s });
    if (s === want) return { reached: true, ms: Date.now() - from, transitions };
    if (Date.now() - from > maxMs) return { reached: false, ms: Date.now() - from, transitions };
    await sleep(POLL_MS);
  }
}

export const fmtTransitions = (t: Transition[]) =>
  t.map((x) => `${x.status}@${Math.round(x.atMs / 1000)}s`).join(" > ");

/** Projects in the org whose name starts with PREFIX (and optionally contains `needle`). */
export async function listOurs(
  ctx: Ctx,
  org: string,
  needle = "",
): Promise<{ ref: string; name: string; status: string }[]> {
  const r = await mgmtPatient(ctx, "GET", `/organizations/${org}/projects?limit=100`);
  const arr = (r.json as { projects?: { ref?: string; name?: string; status?: string }[] } | undefined)?.projects ?? [];
  return arr
    .filter((p) => p.ref && p.name?.startsWith(PREFIX) && p.name.includes(needle))
    .map((p) => ({ ref: p.ref as string, name: p.name as string, status: p.status ?? "?" }));
}

/** DELETE only if the project's name starts with PREFIX; returns HTTP status or -1 when refused. */
export async function deleteOurs(ctx: Ctx, ref: string): Promise<number> {
  const info = await mgmtPatient(ctx, "GET", `/projects/${ref}`);
  const name = String((info.json as { name?: string } | undefined)?.name ?? "");
  if (info.status === 404) return 404;
  if (!name.startsWith(PREFIX)) return -1;
  const del = await mgmtPatient(ctx, "DELETE", `/projects/${ref}`);
  return del.status;
}

/** Seconds until a deleted ref stops being listed in the org listing; -1 if it never did. */
export async function waitGone(ctx: Ctx, org: string, ref: string, maxMs = 300_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await mgmtPatient(ctx, "GET", `/organizations/${org}/projects?limit=100`);
    const arr = (r.json as { projects?: { ref?: string }[] } | undefined)?.projects ?? [];
    if (!arr.some((p) => p.ref === ref)) return Math.round((Date.now() - t0) / 1000);
    await sleep(POLL_MS);
  }
  return -1;
}

/** Build the per-project Ctx the probes and Management calls need. */
export async function projectCtx(ctx: Ctx, ref: string, dbPassword: string): Promise<Ctx | null> {
  const keys = await mgmtPatient(ctx, "GET", `/projects/${ref}/api-keys`);
  const anon = (keys.json as { name?: string; api_key?: string }[] | undefined)?.find?.((k) => k.name === "anon")?.api_key;
  if (!anon) return null;
  return {
    ...ctx,
    ref,
    phzHost: `db.${ref}.${ctx.apiHostSuffix ?? "supabase.co"}`,
    apiHost: `${ref}.${ctx.apiHostSuffix ?? "supabase.co"}`,
    dbPassword,
    anonKey: anon,
  };
}

/**
 * In-process handoff from LO04 to LO05 so the pair costs the creates of LO04
 * alone: when LO_HANDOFF=1, LO04 leaves its first project running and LO05
 * restarts it instead of creating another. Whoever holds the project deletes it.
 */
export const handoff: { ref?: string; dbPass?: string; org?: string; createdAtMs?: number } = {};
