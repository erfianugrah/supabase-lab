import { describe, expect, test } from "bun:test";
import { ageDays, byCreation, eligibleValue, rowLine, summarise, toRow } from "./eligibility";

const NOW = Date.UTC(2026, 9, 13);

describe("eligibleValue", () => {
  test("null, missing and unreadable are three different answers", () => {
    expect(eligibleValue(200, { eligible: null })).toBe("null");
    expect(eligibleValue(200, { current_app_version: "x" })).toBe("absent");
    expect(eligibleValue(404, { eligible: true })).toBe("unread");
    expect(eligibleValue(200, undefined)).toBe("unread");
    expect(eligibleValue(200, [])).toBe("unread");
  });

  test("booleans", () => {
    expect(eligibleValue(200, { eligible: true })).toBe("true");
    expect(eligibleValue(200, { eligible: false })).toBe("false");
  });
});

describe("toRow", () => {
  test("an eligible aged project", () => {
    const r = toRow(
      3,
      { org: "pro", created_at: "2026-08-04T00:00:00Z", status: "ACTIVE_HEALTHY", region: "ap-southeast-1" },
      200,
      {
        eligible: true,
        current_app_version: "17.6.1.141",
        latest_app_version: "17.6.1.155",
        duration_estimate_hours: 1,
        target_upgrade_versions: [{}],
        validation_errors: [],
      },
      NOW,
    );
    expect(r.index).toBe("p03");
    expect(r.ageDays).toBe(70);
    expect(r.eligible).toBe("true");
    expect(r.targets).toBe(1);
    expect(r.keys).toBe("current_app_version,duration_estimate_hours,eligible,latest_app_version,target_upgrade_versions,validation_errors");
    expect(rowLine(r)).toBe(
      "p03 org=pro age_d=70 status=ACTIVE_HEALTHY region=ap-southeast-1 http=200 eligible=true current=17.6.1.141 latest=17.6.1.155 targets=1 validation_errors=0 keys=current_app_version,duration_estimate_hours,eligible,latest_app_version,target_upgrade_versions,validation_errors",
    );
  });

  test("eligible null with no version fields (the 2026-08-04 shape; the error text is a fixture)", () => {
    const r = toRow(1, { created_at: "garbage", status: "INACTIVE" }, 200, { eligible: null, validation_errors: ["project is paused"] }, NOW);
    expect(r.ageDays).toBeNull();
    expect(r.eligible).toBe("null");
    expect(r.current).toBe("n/a");
    expect(r.region).toBe("unknown");
    expect(r.org).toBe("?");
    expect(r.firstValidationError).toBe("project is paused");
    expect(rowLine(r)).toContain("first_error=project is paused");
  });

  test("a non-200 has no payload keys", () => {
    const r = toRow(2, { status: "ACTIVE_HEALTHY" }, 500, { message: "boom" }, NOW);
    expect(r.eligible).toBe("unread");
    expect(r.httpStatus).toBe(500);
  });
});

describe("byCreation and ageDays", () => {
  test("oldest first, undated last", () => {
    const sorted = byCreation([
      { created_at: "2026-10-01T00:00:00Z", status: "b" },
      { status: "undated" },
      { created_at: "2026-08-01T00:00:00Z", status: "a" },
    ]);
    expect(sorted.map((p) => p.status)).toEqual(["a", "b", "undated"]);
  });

  test("whole days, floor", () => {
    expect(ageDays("2026-10-12T01:00:00Z", NOW)).toBe(0);
    expect(ageDays(undefined, NOW)).toBeNull();
  });
});

describe("summarise", () => {
  test("counts, and the null rows set beside their status and payload shape", () => {
    const rows = [
      toRow(1, { status: "INACTIVE" }, 200, { eligible: null }, NOW),
      toRow(2, { status: "ACTIVE_HEALTHY" }, 200, { eligible: true, current_app_version: "a" }, NOW),
      toRow(3, { status: "ACTIVE_HEALTHY" }, 200, { eligible: false, current_app_version: "a" }, NOW),
      toRow(4, { status: "ACTIVE_HEALTHY" }, 200, { eligible: null, current_app_version: "a" }, NOW),
      toRow(5, { status: "COMING_UP" }, 503, undefined, NOW),
    ];
    expect(summarise(rows)).toEqual({
      projects_read: 5,
      eligible_true: 1,
      eligible_false: 1,
      eligible_null: 2,
      eligible_absent: 0,
      eligible_unread: 1,
      status_by_eligible: "ACTIVE_HEALTHY/false:1|ACTIVE_HEALTHY/null:1|ACTIVE_HEALTHY/true:1|COMING_UP/unread:1|INACTIVE/null:1",
      null_statuses: "ACTIVE_HEALTHY:1|INACTIVE:1",
      null_with_version_fields: 1,
      null_payload_keys: "current_app_version,eligible:1|eligible:1",
    });
  });

  test("no projects", () => {
    expect(summarise([]).null_statuses).toBe("none");
  });
});
