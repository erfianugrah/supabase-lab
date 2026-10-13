/**
 * F07 support (work-supabase-lab#41): read upgrade eligibility across every
 * project a token can list, so `eligible: null` (seen once on 2026-08-04,
 * RUNLOG "F06, the upgrade window") can be set beside each project's status, age and
 * payload shape instead of being one unexplained row.
 *
 * Rows carry NO project ref and NO name: projects are numbered in creation
 * order, so the artifact can be published as is. Pure: unit-tested in
 * eligibility.test.ts.
 */

export type EligibleValue = "true" | "false" | "null" | "absent" | "unread";

export interface ListedProject {
  /** A label for the organization (its PVLAB_ORG_<ROLE> role, else o1, o2, ...), never the slug. */
  org?: unknown;
  created_at?: unknown;
  status?: unknown;
  region?: unknown;
}

export interface EligibilityRow {
  /** p01, p02, ... in creation order. */
  index: string;
  org: string;
  ageDays: number | null;
  status: string;
  region: string;
  httpStatus: number;
  eligible: EligibleValue;
  /** Top-level keys of the eligibility payload, sorted, comma-joined. */
  keys: string;
  current: string;
  latest: string;
  targets: number;
  validationErrors: number;
  firstValidationError: string;
}

/** What `eligible` was, keeping "the field is null" apart from "the field is missing" and "no payload". */
export function eligibleValue(httpStatus: number, json: unknown): EligibleValue {
  if (httpStatus !== 200 || !json || typeof json !== "object" || Array.isArray(json)) return "unread";
  const rec = json as Record<string, unknown>;
  if (!("eligible" in rec)) return "absent";
  if (rec.eligible === null) return "null";
  if (rec.eligible === true) return "true";
  if (rec.eligible === false) return "false";
  return "unread";
}

const str = (v: unknown, fallback = "n/a") => (typeof v === "string" && v ? v : fallback);

export function ageDays(createdAt: unknown, nowMs: number): number | null {
  if (typeof createdAt !== "string") return null;
  const t = Date.parse(createdAt);
  return Number.isNaN(t) ? null : Math.floor((nowMs - t) / 86_400_000);
}

/** One row per project. `position` is 1-based creation order. */
export function toRow(position: number, project: ListedProject, httpStatus: number, json: unknown, nowMs: number): EligibilityRow {
  const rec = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const errors = Array.isArray(rec.validation_errors) ? rec.validation_errors : [];
  const first = errors[0];
  return {
    index: `p${String(position).padStart(2, "0")}`,
    org: str(project.org, "?"),
    ageDays: ageDays(project.created_at, nowMs),
    status: str(project.status, "unknown"),
    region: str(project.region, "unknown"),
    httpStatus,
    eligible: eligibleValue(httpStatus, json),
    keys: Object.keys(rec).sort().join(","),
    current: str(rec.current_app_version),
    latest: str(rec.latest_app_version),
    targets: Array.isArray(rec.target_upgrade_versions) ? rec.target_upgrade_versions.length : 0,
    validationErrors: errors.length,
    firstValidationError: (first === undefined ? "" : typeof first === "string" ? first : JSON.stringify(first)).slice(0, 120),
  };
}

/** Oldest first, so p01 is the oldest project and the numbering is stable between runs. */
export function byCreation(projects: ListedProject[]): ListedProject[] {
  const t = (p: ListedProject) => (typeof p.created_at === "string" ? Date.parse(p.created_at) : Number.NaN);
  return [...projects].sort((a, b) => {
    const ta = t(a);
    const tb = t(b);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

function histogram(values: string[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, n]) => `${k}:${n}`).join("|") || "none";
}

export function summarise(rows: EligibilityRow[]): Record<string, string | number> {
  const nulls = rows.filter((r) => r.eligible === "null");
  return {
    projects_read: rows.length,
    eligible_true: rows.filter((r) => r.eligible === "true").length,
    eligible_false: rows.filter((r) => r.eligible === "false").length,
    eligible_null: nulls.length,
    eligible_absent: rows.filter((r) => r.eligible === "absent").length,
    eligible_unread: rows.filter((r) => r.eligible === "unread").length,
    status_by_eligible: histogram(rows.map((r) => `${r.status}/${r.eligible}`)),
    null_statuses: histogram(nulls.map((r) => r.status)),
    null_with_version_fields: nulls.filter((r) => r.keys.split(",").includes("current_app_version")).length,
    null_payload_keys: histogram(nulls.map((r) => r.keys || "(empty)")),
  };
}

export function rowLine(r: EligibilityRow): string {
  return [
    r.index,
    `org=${r.org}`,
    `age_d=${r.ageDays ?? "?"}`,
    `status=${r.status}`,
    `region=${r.region}`,
    `http=${r.httpStatus}`,
    `eligible=${r.eligible}`,
    `current=${r.current}`,
    `latest=${r.latest}`,
    `targets=${r.targets}`,
    `validation_errors=${r.validationErrors}`,
    `keys=${r.keys || "(empty)"}`,
    ...(r.firstValidationError ? [`first_error=${r.firstValidationError}`] : []),
  ].join(" ");
}
