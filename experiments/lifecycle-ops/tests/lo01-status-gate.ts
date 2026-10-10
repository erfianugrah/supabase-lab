/**
 * LO01 - what the public status page can and cannot tell a change gate.
 *
 * Read-only, no credential. Fetches components.json and incidents.json
 * (https://status.supabase.com/api/v2/, incident.io-backed since 2026-10-07)
 * and measures the properties the gate in lib/gate.ts is built around:
 *
 *   LO01a  components.json shape: total components, how many times each region
 *          name occurs, whether any group/service field exists, status values.
 *   LO01b  incidents.json shape: count, keys, whether an incident names its
 *          affected components or regions in a structured field, whether
 *          /incidents/unresolved.json exists.
 *   LO01c  the gate's decision for every region now (what the page says today,
 *          one observation, not a distribution).
 *   LO01d  replay over the incidents.json feed (the most recent 25 incidents at
 *          fetch time): per region, hours a restart would have been refused,
 *          how the region scope was recovered (title / body / none), and how
 *          often `impact` was "none" for an incident the gate would block.
 *
 * Pass condition: the fetch worked. Everything else is recorded as data.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import {
  REGIONS,
  STATUS_BASE,
  decide,
  fetchStatus,
  incidentRegions,
  replayInterval,
  unionMs,
  type Op,
} from "../lib/gate";

const mod: TestModule = {
  id: "LO01",
  title: "Status page shape and change-gate replay",
  where: "local",
  async run(ctx): Promise<TestResult[]> {
    const snap = await fetchStatus();
    if (snap.error) {
      return [{ id: "LO01", title: mod.title, status: "fail", detail: `status unreadable: ${snap.error}` }];
    }
    const out: TestResult[] = [];

    // ---- a: components shape ----
    const names = new Map<string, number>();
    for (const c of snap.components) names.set(c.name, (names.get(c.name) ?? 0) + 1);
    const regionCounts = REGIONS.map((r) => names.get(r) ?? 0);
    const nonRegion = [...names.keys()].filter((n) => !(REGIONS as readonly string[]).includes(n));
    const compKeys = [...new Set(snap.components.flatMap((c) => Object.keys(c)))].sort();
    const statuses = [...new Set(snap.components.map((c) => c.status))];
    out.push({
      id: "LO01a",
      title: "LO01a: components.json shape",
      status: "info",
      measurements: {
        components: snap.components.length,
        regions_present: regionCounts.filter((n) => n > 0).length,
        region_name_occurrences_min: Math.min(...regionCounts),
        region_name_occurrences_max: Math.max(...regionCounts),
        has_group_or_service_field: compKeys.some((k) => /group|service|parent/i.test(k)) ? 1 : 0,
        distinct_statuses: statuses.join(","),
        non_region_components: nonRegion.join(" | "),
        components_http: snap.componentsHttp,
        fetch_ms: snap.fetchMs,
      },
      evidence: `component keys: ${compKeys.join(",")}`,
    });

    // ---- b: incidents shape ----
    const incKeys = [...new Set(snap.incidents.flatMap((i) => Object.keys(i)))].sort();
    const unresolved = await fetch(`${STATUS_BASE}/incidents/unresolved.json`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const summary = (await fetch(`${STATUS_BASE}/summary.json`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json())
      .catch(() => ({}))) as { scheduled_maintenances?: unknown[] };
    const first = snap.incidents.map((i) => Date.parse(i.created_at)).reduce((a, b) => Math.min(a, b), Infinity);
    const open = snap.incidents.filter((i) => !["resolved", "completed", "postmortem"].includes(i.status));
    out.push({
      id: "LO01b",
      title: "LO01b: incidents.json shape",
      status: "info",
      measurements: {
        incidents: snap.incidents.length,
        oldest_created: new Date(first).toISOString().slice(0, 10),
        open_now: open.length,
        has_component_or_region_field: incKeys.some((k) => /component|region|affect/i.test(k)) ? 1 : 0,
        unresolved_json_http: unresolved?.status ?? 0,
        summary_scheduled_maintenances: summary.scheduled_maintenances?.length ?? -1,
        incidents_http: snap.incidentsHttp,
      },
      evidence: `incident keys: ${incKeys.join(",")}`,
    });

    // ---- c: decisions now ----
    const ops: Op[] = ["create", "restart", "resize", "upgrade"];
    const proceedByOp: Record<string, number> = {};
    for (const op of ops) {
      proceedByOp[`${op}_regions_proceed_of_${REGIONS.length}`] = REGIONS.filter(
        (r) => decide(r, op, snap.components, snap.incidents).proceed,
      ).length;
    }
    const sg = decide("ap-southeast-1", "restart", snap.components, snap.incidents);
    out.push({
      id: "LO01c",
      title: "LO01c: gate decision per region, now",
      status: "info",
      detail: `ap-southeast-1 restart: ${sg.proceed ? "proceed" : "BLOCK"} (region status ${sg.regionStatus}, ${sg.regionComponentsMatched} components, ${sg.blockers.length} blockers, ${sg.warnings.length} warnings)`,
      measurements: { ...proceedByOp, observed_at: new Date().toISOString() },
      evidence: [...sg.blockers, ...sg.warnings].join("\n") || undefined,
    });

    // ---- d: replay ----
    const windowMs = Date.now() - first;
    const perRegion: Record<string, number> = {};
    let bad = 0;
    for (const r of REGIONS) {
      const ivs: { startMs: number; endMs: number }[] = [];
      for (const inc of snap.incidents) {
        const iv = replayInterval(inc, r, "restart");
        if (iv && iv !== "bad-interval") ivs.push(iv);
      }
      perRegion[r] = Math.round((unionMs(ivs) / 3_600_000) * 10) / 10;
    }
    const sgH = perRegion["ap-southeast-1"] as number;
    const scopes = { regions: 0, "body-regions": 0, "all-regions": 0, unscoped: 0 };
    let noneImpactBlocked = 0;
    let blockedSomewhere = 0;
    for (const inc of snap.incidents) {
      const sc = incidentRegions(inc);
      scopes[sc.scope] += 1;
      if (REGIONS.some((r) => replayInterval(inc, r, "restart") === "bad-interval")) bad += 1;
      if (REGIONS.some((r) => { const iv = replayInterval(inc, r, "restart"); return iv && iv !== "bad-interval"; })) {
        blockedSomewhere += 1;
        if (inc.impact === "none") noneImpactBlocked += 1;
      }
    }
    out.push({
      id: "LO01d",
      title: "LO01d: replay of the incident feed through the gate (restart)",
      status: "info",
      detail: `window ${Math.round(windowMs / 3_600_000)} h; ap-southeast-1 restart refused ${sgH} h; region hours max ${Math.max(...Object.values(perRegion))}`,
      measurements: {
        window_h: Math.round(windowMs / 3_600_000),
        incidents_scope_title_region: scopes.regions,
        incidents_scope_body_region_only: scopes["body-regions"],
        incidents_scope_all_regions: scopes["all-regions"],
        incidents_scope_unscoped: scopes.unscoped,
        incidents_blocking_some_region: blockedSomewhere,
        of_those_impact_none: noneImpactBlocked,
        incidents_resolved_before_created: bad,
        ap_southeast_1_refused_h: sgH,
        eu_west_1_refused_h: perRegion["eu-west-1"] as number,
        us_east_1_refused_h: perRegion["us-east-1"] as number,
        min_region_refused_h: Math.min(...Object.values(perRegion)),
      },
      evidence: Object.entries(perRegion).map(([k, v]) => `${k}\t${v}`).join("\n"),
    });
    return out;
  },
};
export default mod;
