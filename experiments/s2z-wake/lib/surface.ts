/**
 * The Management API surface under test, and the two helpers every module here
 * needs.
 *
 * The endpoint lists are DERIVED, not hand-written: `scripts/gen-surface.ts`
 * regenerates this file from the published OpenAPI document. Hand-editing the
 * lists reintroduces exactly the failure the F05 method note in
 * `platform-facts` warns about - concluding something about "the API" from a
 * set someone assembled by guessing path names. Regenerate instead.
 *
 * Generated from api.supabase.green/api/v1-json on 2026-09-09, which carried
 * the same 169 (verb, path) pairs as production that day.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Project status read from the ORG-scoped listing rather than
 * `GET /projects/{ref}`, deliberately: the project route is itself one of the
 * endpoints under test, and an instrument inside the set it measures cannot
 * distinguish "this call woke it" from "the check woke it".
 *
 * A staging PAT is org-scoped and returns [] from the account-wide
 * `GET /v1/projects`, so the org route is also the only one that answers.
 */
export async function projectStatus(ctx: Ctx, org: string, ref: string): Promise<string> {
  const r = await mgmt(ctx, "GET", `/organizations/${org}/projects`).catch(() => null);
  if (!r) return "ERR";
  const list = (r.json as { projects?: { ref?: string; status?: string }[] } | undefined)?.projects ?? [];
  return list.find((p) => p?.ref === ref)?.status ?? "ERR";
}

/** Poll the org listing until `want`; returns seconds and the states seen. */
export async function waitStatus(
  ctx: Ctx,
  org: string,
  ref: string,
  want: string,
  maxS = 900,
): Promise<{ seconds: number; reached: boolean; seen: string[] }> {
  const t0 = Date.now();
  const seen: string[] = [];
  for (;;) {
    const s = await projectStatus(ctx, org, ref);
    if (!seen.includes(s)) seen.push(s);
    if (s === want) return { seconds: Math.round((Date.now() - t0) / 1000), reached: true, seen };
    if (Date.now() - t0 > maxS * 1000) {
      return { seconds: Math.round((Date.now() - t0) / 1000), reached: false, seen };
    }
    await sleep(5_000);
  }
}

/**
 * Query strings for the endpoints that need one. Without these the endpoint
 * answers 400 on its own arguments and the run measures our request shape
 * instead of the project's state.
 */
export function queryFor(path: string): string {
  if (path.endsWith("/health")) return "?services=db,rest,auth,realtime,storage";
  if (path.includes("/analytics/endpoints/")) {
    const end = new Date();
    const start = new Date(end.getTime() - 3_600_000);
    return `?iso_timestamp_start=${start.toISOString().replace(/\.\d+Z$/, "Z")}` +
      `&iso_timestamp_end=${end.toISOString().replace(/\.\d+Z$/, "Z")}`;
  }
  return "";
}

/**
 * Every project GET whose only path parameter is {ref}, so it is callable with
 * no setup. Ordered least-likely-to-wake first (analytics and control-plane
 * metadata before anything that must open a Postgres connection) so one parked
 * window buys as many readings as possible before a waker ends it.
 */
export const PARAMLESS_GETS: string[] = [
  "/analytics/endpoints/functions.combined-stats",
  "/analytics/endpoints/logs",
  "/analytics/endpoints/logs.all",
  "/analytics/endpoints/usage.api-counts",
  "/analytics/endpoints/usage.api-requests-count",
  "",
  "/actions",
  "/api-keys",
  "/api-keys/legacy",
  "/billing/addons",
  "/branches",
  "/claim-token",
  "/custom-hostname",
  "/network-restrictions",
  "/secrets",
  "/ssl-enforcement",
  "/vanity-subdomain",
  "/config/auth",
  "/config/auth/signing-keys",
  "/config/auth/signing-keys/legacy",
  "/config/auth/sso/providers",
  "/config/auth/third-party-auth",
  "/config/database/pgbouncer",
  "/config/database/pooler",
  "/config/database/postgres",
  "/config/disk",
  "/config/disk/autoscale",
  "/config/disk/util",
  "/config/realtime",
  "/jit-access",
  "/pgsodium",
  "/postgrest",
  "/readonly",
  "/database/backups",
  "/database/backups/restore-point",
  "/database/backups/schedule",
  "/health",
  "/config/storage",
  "/functions",
  "/storage/buckets",
  "/restore",
  "/upgrade/eligibility",
  "/upgrade/status",
  "/database/jit",
  "/database/jit/list",
  "/advisors/performance",
  "/advisors/security",
  "/types/typescript",
  "/analytics/endpoints/metrics",
  "/database/context",
  "/database/migrations",
  "/database/openapi",
];

/**
 * Endpoints that answer 200 with an EMPTY result on a parked project when they
 * answered 200 with CONTENT while awake - so a caller checking only the status
 * code cannot tell "nothing to report" from "could not look".
 *
 * The comparison against the awake pass is load-bearing. The first version of
 * this check flagged any 200-with-small-body while parked and reported eight
 * "new" degraders on the first real run: `/actions`, `/branches`, `/functions`,
 * `/secrets` and friends are legitimately `[]` on a fresh project, awake or
 * parked. `/advisors/security` was in this list for the same bad reason -
 * a fresh project has no security lints, so it reads `{"lints":[]}` either way
 * and this experiment cannot tell whether parking silenced it.
 *
 * Measured 2026-09-09 on a project seeded with a real advisor finding.
 */
export const SILENT_DEGRADERS = [
  "/api-keys",
  "/advisors/performance",
  "/config/database/pooler",
] as const;
