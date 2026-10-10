import { describe, expect, test } from "bun:test";
import {
  decide,
  restartWaitMs,
  incidentRegions,
  regionStatus,
  replayInterval,
  unionMs,
  type StatusComponent,
  type StatusIncident,
} from "./gate";

const comp = (name: string, status = "operational", id = Math.random().toString(36)): StatusComponent => ({
  id,
  name,
  status,
});
const inc = (over: Partial<StatusIncident>): StatusIncident => ({
  id: "01TEST",
  name: "x",
  status: "investigating",
  impact: "none",
  created_at: "2026-10-01T00:00:00Z",
  resolved_at: null,
  ...over,
});

describe("regionStatus", () => {
  test("takes the worst of duplicate-named components, not the first", () => {
    const cs = [comp("eu-west-1"), comp("eu-west-1"), comp("eu-west-1", "partial_outage"), comp("us-east-1")];
    const r = regionStatus(cs, "eu-west-1");
    expect(r.status).toBe("partial_outage");
    expect(r.matched).toBe(3);
  });
  test("missing region and unknown status both fail closed", () => {
    expect(regionStatus([comp("us-east-1")], "eu-west-1").status).toBe("missing");
    expect(decide("eu-west-1", "restart", [comp("eu-west-1", "mystery")], []).proceed).toBe(false);
    expect(decide("eu-west-1", "restart", [comp("us-east-1")], []).proceed).toBe(false);
  });
});

describe("incidentRegions", () => {
  test("region code, prose alias, all-regions, unscoped", () => {
    expect(incidentRegions(inc({ name: "Project Lifecycle Issues in eu-west-1" }))).toEqual({
      scope: "regions",
      regions: ["eu-west-1"],
    });
    expect(incidentRegions(inc({ name: "Supavisor disruptions in EU West 1 (Ireland)" })).regions).toEqual([
      "eu-west-1",
    ]);
    expect(incidentRegions(inc({ name: "Brief disruptions in us-east-1 (N. Virginia)" })).regions).toEqual([
      "us-east-1",
    ]);
    expect(incidentRegions(inc({ name: "Creations degraded in multiple regions" })).scope).toBe("all-regions");
    expect(incidentRegions(inc({ name: "Upgrade Issues" })).scope).toBe("unscoped");
  });
  test("update body can carry the region when the title does not", () => {
    const i = inc({
      name: "Increased errors",
      incident_updates: [{ body: "affects ap-southeast-1 only", status: "investigating", created_at: "" }],
    });
    expect(incidentRegions(i)).toEqual({ scope: "body-regions", regions: ["ap-southeast-1"] });
  });
});

describe("decide", () => {
  const ok = [comp("ap-southeast-1"), comp("eu-west-1")];
  test("clean page proceeds", () => {
    expect(decide("ap-southeast-1", "restart", ok, []).proceed).toBe(true);
  });
  test("open incident naming the region blocks; other region only warns", () => {
    const i = inc({ name: "Project Lifecycle Issues in eu-west-1" });
    expect(decide("eu-west-1", "restart", ok, [i]).proceed).toBe(false);
    const d = decide("ap-southeast-1", "restart", ok, [i]);
    expect(d.proceed).toBe(true);
    expect(d.warnings.length).toBe(1);
  });
  test("impact none does not stop an unscoped upgrade incident blocking an upgrade", () => {
    const i = inc({ name: "Upgrade Issues", impact: "none" });
    expect(decide("ap-southeast-1", "upgrade", ok, [i]).proceed).toBe(false);
    expect(decide("ap-southeast-1", "restart", ok, [i]).proceed).toBe(true);
  });
  test("region only in a rollout list in the body warns; with lifecycle wording it blocks", () => {
    const rollout = inc({
      name: "Increased response times for requests",
      incident_updates: [{ body: "PostgREST deployed to ap-southeast-1 and eu-west-1", status: "identified", created_at: "" }],
    });
    const d = decide("ap-southeast-1", "restart", ok, [rollout]);
    expect(d.proceed).toBe(true);
    expect(d.warnings.length).toBe(1);
    const lc = inc({
      name: "Increased errors",
      incident_updates: [{ body: "project operation failures in ap-southeast-1", status: "investigating", created_at: "" }],
    });
    expect(decide("ap-southeast-1", "restart", ok, [lc]).proceed).toBe(false);
  });
  test("resolved incidents are ignored", () => {
    const i = inc({ name: "Project Lifecycle Issues in eu-west-1", status: "resolved" });
    expect(decide("eu-west-1", "restart", ok, [i]).proceed).toBe(true);
  });
});

describe("replay", () => {
  test("interval for a regional incident, null elsewhere, bad-interval flagged", () => {
    const i = inc({
      name: "Project Lifecycle Issues in eu-west-1",
      status: "resolved",
      created_at: "2026-09-24T15:00:00Z",
      resolved_at: "2026-09-24T17:00:00Z",
    });
    const r = replayInterval(i, "eu-west-1", "restart");
    expect(r).not.toBeNull();
    expect(r).not.toBe("bad-interval");
    if (r && r !== "bad-interval") expect(r.endMs - r.startMs).toBe(2 * 3600_000);
    expect(replayInterval(i, "us-east-1", "restart")).toBeNull();
    expect(replayInterval({ ...i, resolved_at: "2026-09-24T14:00:00Z" }, "eu-west-1", "restart")).toBe("bad-interval");
  });
  test("unionMs merges overlaps", () => {
    expect(
      unionMs([
        { startMs: 0, endMs: 10 },
        { startMs: 5, endMs: 20 },
        { startMs: 30, endMs: 40 },
      ]),
    ).toBe(30);
  });
});

describe("restartWaitMs", () => {
  test("ten minutes after create completion, never negative", () => {
    expect(restartWaitMs(0, 0)).toBe(600_000);
    expect(restartWaitMs(0, 590_000)).toBe(10_000);
    expect(restartWaitMs(0, 700_000)).toBe(0);
  });
});
