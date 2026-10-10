/**
 * Change gate: should a lifecycle operation (create, restart, resize, upgrade)
 * be sent to a region right now, according to the public status page?
 *
 * Source: https://status.supabase.com/api/v2/components.json and
 * incidents.json (Atlassian Statuspage-shaped JSON served by incident.io since
 * 2026-10-07; ids are ULIDs). Two measured properties of those documents shape
 * everything below (LO01, RUNLOG):
 *
 *  1. components.json carries every region name 10 or 11 times (one per
 *     service, with no group or service field), so "find the component named
 *     <region>" returns an arbitrary one of them. The gate takes the WORST
 *     status across all components with the region's name.
 *  2. incidents carry no component or region field, and `impact` does not track
 *     lifecycle damage (an upgrade suspension and a project-creation
 *     degradation were both published as impact "none"). Region scope is read
 *     from the incident text; impact is ignored for the decision.
 *
 * Pure functions only; fetching is separate so everything here is unit tested
 * with fixtures (gate.test.ts).
 */

export const STATUS_BASE = "https://status.supabase.com/api/v2";

export type Op = "create" | "restart" | "resize" | "upgrade";

export interface StatusComponent {
  id: string;
  name: string;
  status: string;
}

export interface IncidentUpdate {
  body: string;
  status: string;
  created_at: string;
}

export interface StatusIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  created_at: string;
  resolved_at: string | null;
  incident_updates?: IncidentUpdate[];
}

export const REGIONS = [
  "ap-east-1", "ap-northeast-1", "ap-northeast-2", "ap-south-1", "ap-southeast-1",
  "ap-southeast-2", "ca-central-1", "eu-central-1", "eu-central-2", "eu-north-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "sa-east-1", "us-east-1", "us-east-2",
  "us-west-1", "us-west-2",
] as const;

/** Prose spellings that appear in incident text instead of the region code. */
const ALIASES: Record<string, RegExp[]> = {
  "eu-west-1": [/\bireland\b/i],
  "us-east-1": [/\bn\.? ?virginia\b/i, /\beastern us\b/i],
  "us-west-1": [/\bn\.? ?california\b/i],
  "ap-southeast-1": [/\bsingapore\b/i],
  "eu-central-1": [/\bfrankfurt\b/i],
};

const SEVERITY: Record<string, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

/** Unknown status strings rank above major_outage: fail closed. */
export function rank(status: string): number {
  return SEVERITY[status] ?? 5;
}

/** Worst status across every component whose name is the region code. */
export function regionStatus(
  components: StatusComponent[],
  region: string,
): { status: string; matched: number; statuses: string[] } {
  const same = components.filter((c) => c.name === region);
  if (same.length === 0) return { status: "missing", matched: 0, statuses: [] };
  let worst = "operational";
  for (const c of same) if (rank(c.status) > rank(worst)) worst = c.status;
  return { status: worst, matched: same.length, statuses: [...new Set(same.map((c) => c.status))] };
}

/**
 * regions: a region is named in the incident TITLE. body-regions: regions
 * appear only in update bodies (rollout lists, "recovered in all regions"),
 * which LO01 measured to be mostly NOT damage. all-regions / unscoped as named.
 */
export type Scope = "regions" | "body-regions" | "all-regions" | "unscoped";

const ALL_REGIONS_RE = /\b(all|multiple|several|many) regions\b|\bglobal(ly)?\b/i;

export function incidentText(inc: StatusIncident): string {
  return [inc.name, ...(inc.incident_updates ?? []).map((u) => u.body)].join("\n");
}

function regionsIn(text: string): string[] {
  const spaced = (r: string) => new RegExp(`\\b${r.replace(/-/g, "[- ]")}\\b`, "i");
  return REGIONS.filter((r) => spaced(r).test(text) || (ALIASES[r] ?? []).some((re) => re.test(text)));
}

/** Regions named in the incident title or any update body, plus the scope class. */
export function incidentRegions(inc: StatusIncident): { scope: Scope; regions: string[] } {
  const inTitle = regionsIn(inc.name);
  if (ALL_REGIONS_RE.test(inc.name)) return { scope: "all-regions", regions: inTitle };
  if (inTitle.length > 0) return { scope: "regions", regions: inTitle };
  const inBody = regionsIn(incidentText(inc));
  if (inBody.length > 0) return { scope: "body-regions", regions: inBody };
  return { scope: "unscoped", regions: [] };
}

/** What kind of change an incident text says is affected. */
const LIFECYCLE_RE: Record<Op, RegExp> = {
  create: /creat|provision|lifecycle|management api|project operation|capacity/i,
  restart: /restart|lifecycle|management api|project operation|unresponsive|capacity/i,
  resize: /resiz|disk|compute|lifecycle|management api|project operation|capacity/i,
  upgrade: /upgrad|lifecycle|management api|project operation|capacity/i,
};

export function isOpen(inc: StatusIncident): boolean {
  return !["resolved", "completed", "postmortem"].includes(inc.status);
}

export interface Decision {
  proceed: boolean;
  region: string;
  op: Op;
  regionStatus: string;
  regionComponentsMatched: number;
  blockers: string[];
  warnings: string[];
}

export interface Policy {
  /** Block on a still-open incident that names no region but is about lifecycle ops. */
  blockUnscopedLifecycle: boolean;
  /** Block when the region components cannot be found at all. */
  blockOnMissingRegion: boolean;
}

export const DEFAULT_POLICY: Policy = { blockUnscopedLifecycle: true, blockOnMissingRegion: true };

export function decide(
  region: string,
  op: Op,
  components: StatusComponent[],
  incidents: StatusIncident[],
  policy: Policy = DEFAULT_POLICY,
): Decision {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const rs = regionStatus(components, region);

  if (rs.status === "missing") {
    (policy.blockOnMissingRegion ? blockers : warnings).push(`no component named ${region}`);
  } else if (rs.status !== "operational") {
    blockers.push(`component status ${rs.status} (${rs.matched} components named ${region})`);
  }

  for (const inc of incidents.filter(isOpen)) {
    const { scope, regions } = incidentRegions(inc);
    const lifecycle = LIFECYCLE_RE[op].test(incidentText(inc));
    const tag = `${inc.id} "${inc.name}" (${inc.status}, impact ${inc.impact})`;
    if (scope === "all-regions") blockers.push(`open, all regions: ${tag}`);
    else if (scope === "regions" && regions.includes(region)) blockers.push(`open, names ${region}: ${tag}`);
    else if (scope === "body-regions" && regions.includes(region)) {
      (lifecycle ? blockers : warnings).push(`open, ${region} in update text${lifecycle ? " with lifecycle wording" : " only"}: ${tag}`);
    } else if (scope === "regions" || scope === "body-regions") {
      warnings.push(`open, other region(s) ${regions.join(",")}: ${tag}`);
    }
    else if (lifecycle) {
      (policy.blockUnscopedLifecycle ? blockers : warnings).push(`open, no region, lifecycle wording: ${tag}`);
    } else warnings.push(`open, no region, not lifecycle: ${tag}`);
  }
  return {
    proceed: blockers.length === 0,
    region,
    op,
    regionStatus: rs.status,
    regionComponentsMatched: rs.matched,
    blockers,
    warnings,
  };
}

/**
 * Replay: would a past incident have blocked `op` in `region`, using only the
 * incident feed (component status is not historical). Returns the closed
 * interval during which the gate would have said no, or null when it would not.
 * An incident whose resolved_at precedes created_at has no usable interval.
 */
export function replayInterval(
  inc: StatusIncident,
  region: string,
  op: Op,
  policy: Policy = DEFAULT_POLICY,
): { startMs: number; endMs: number } | "bad-interval" | null {
  const { scope, regions } = incidentRegions(inc);
  const lifecycle = LIFECYCLE_RE[op].test(incidentText(inc));
  const blocks =
    scope === "all-regions" ||
    (scope === "regions" && regions.includes(region)) ||
    (scope === "body-regions" && regions.includes(region) && lifecycle) ||
    (scope === "unscoped" && lifecycle && policy.blockUnscopedLifecycle);
  if (!blocks) return null;
  const startMs = Date.parse(inc.created_at);
  const endMs = Date.parse(inc.resolved_at ?? "") || Date.now();
  if (!(endMs >= startMs)) return "bad-interval";
  return { startMs, endMs };
}

/** Total ms covered by the union of intervals. */
export function unionMs(intervals: { startMs: number; endMs: number }[]): number {
  const s = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let curEnd = -Infinity;
  let curStart = 0;
  for (const i of s) {
    if (i.startMs > curEnd) {
      if (curEnd > -Infinity) total += curEnd - curStart;
      curStart = i.startMs;
      curEnd = i.endMs;
    } else if (i.endMs > curEnd) curEnd = i.endMs;
  }
  if (curEnd > -Infinity) total += curEnd - curStart;
  return total;
}

export interface StatusSnapshot {
  components: StatusComponent[];
  incidents: StatusIncident[];
  componentsHttp: number;
  incidentsHttp: number;
  fetchMs: number;
  error?: string;
}

export async function fetchStatus(base = STATUS_BASE): Promise<StatusSnapshot> {
  const t0 = Date.now();
  try {
    const [c, i] = await Promise.all([
      fetch(`${base}/components.json`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${base}/incidents.json`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    const cj = c.ok ? ((await c.json()) as { components?: StatusComponent[] }) : {};
    const ij = i.ok ? ((await i.json()) as { incidents?: StatusIncident[] }) : {};
    const ok = c.ok && i.ok && Array.isArray(cj.components) && Array.isArray(ij.incidents);
    return {
      components: cj.components ?? [],
      incidents: ij.incidents ?? [],
      componentsHttp: c.status,
      incidentsHttp: i.status,
      fetchMs: Date.now() - t0,
      ...(ok ? {} : { error: `components HTTP ${c.status}, incidents HTTP ${i.status}` }),
    };
  } catch (e) {
    return {
      components: [],
      incidents: [],
      componentsHttp: 0,
      incidentsHttp: 0,
      fetchMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * The call a change pipeline makes. An unreadable status page BLOCKS by
 * default (design choice, not a measurement): a gate that fails open is not a
 * gate during the incident that also takes the status page down.
 */
export async function gate(
  region: string,
  op: Op,
  opts: { policy?: Policy; failOpen?: boolean; base?: string } = {},
): Promise<Decision & { snapshot: StatusSnapshot }> {
  const snapshot = await fetchStatus(opts.base);
  if (snapshot.error) {
    return {
      proceed: opts.failOpen === true,
      region,
      op,
      regionStatus: "unknown",
      regionComponentsMatched: 0,
      blockers: opts.failOpen ? [] : [`status unreadable: ${snapshot.error}`],
      warnings: opts.failOpen ? [`status unreadable: ${snapshot.error}`] : [],
      snapshot,
    };
  }
  return { ...decide(region, op, snapshot.components, snapshot.incidents, opts.policy), snapshot };
}

/**
 * Operation precondition the status page cannot express (LO05f): POST
 * /v1/projects/{ref}/restart answered HTTP 400 "Project restarts are only
 * allowed ten minutes after the creation process has completed" when sent
 * right after a create. The caller supplies when the create completed (the
 * first time the project read ACTIVE_HEALTHY, or the POST time as a lower
 * bound on age); this returns how many ms remain before a restart is allowed.
 */
export const RESTART_MIN_AGE_MS = 600_000;
export function restartWaitMs(createCompletedAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, createCompletedAtMs + RESTART_MIN_AGE_MS - nowMs);
}
