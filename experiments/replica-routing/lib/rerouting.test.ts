import { describe, expect, test } from "bun:test";
import { buckets, errorModes, lagWindow, parseNode, servedDuring, transitions, type Tick } from "./rerouting";

const k = (t: number, src: string, node?: "primary" | "replica", staleMs?: number, err?: string): Tick => ({
  t,
  src,
  status: node ? 200 : 503,
  node,
  staleMs,
  err,
});

describe("parseNode", () => {
  test("a replica answer", () => {
    expect(parseNode(200, '{"in_recovery":true,"pm":1760000000,"max_id":12,"stale_ms":180}')).toEqual({ node: "replica", pm: 1760000000, staleMs: 180 });
  });
  test("a primary answer", () => {
    expect(parseNode(200, '{"in_recovery":false,"pm":1,"stale_ms":3}').node).toBe("primary");
  });
  test("a PostgREST error keeps its code", () => {
    expect(parseNode(503, '{"code":"PGRST002","message":"Could not query the database"}')).toEqual({ err: "HTTP 503 PGRST002" });
  });
  test("a non-JSON body keeps the status and a short body", () => {
    expect(parseNode(502, "<html>Bad gateway</html>").err).toBe("HTTP 502 <html>Bad gateway</html>");
  });
  test("HTTP 200 without in_recovery is not a node", () => {
    expect(parseNode(200, "[]").node).toBeUndefined();
  });
});

describe("lagWindow", () => {
  const ticks = [k(0, "replica", "replica", 200), k(1000, "replica", "replica", 6000), k(2000, "replica", "replica", 9000), k(3000, "replica", "replica", 300), k(1500, "lb", "replica", 9000)];
  test("spans the direct replica ticks over the threshold only", () => {
    expect(lagWindow(ticks, "replica", 5000)).toEqual({ startT: 1000, endT: 2000, maxStaleMs: 9000 });
  });
  test("null when the threshold is never crossed", () => {
    expect(lagWindow(ticks, "replica", 10_000)).toBeNull();
  });
});

describe("servedDuring", () => {
  const ticks = [
    k(0, "lb", "replica", 200),
    k(1000, "lb", "replica", 7000),
    k(2000, "lb", undefined, undefined, "HTTP 503 PGRST002"),
    k(3000, "lb", "primary", 10),
    k(4000, "lb", "replica", 100),
    k(5000, "replica", "replica", 9000),
  ];
  test("counts per node inside the window, and the stale replica answers", () => {
    const s = servedDuring(ticks, "lb", 1000, 4000, 5000);
    expect(s).toEqual({
      n: 4,
      replica: 2,
      primary: 1,
      errors: 1,
      maxStaleReplicaMs: 7000,
      replicaStale: 1,
      firstPrimaryT: 3000,
      lastReplicaT: 4000,
      firstErrorT: 2000,
      lastErrorT: 2000,
    });
  });
  test("an empty window reads NaN for the stale maximum", () => {
    expect(Number.isNaN(servedDuring(ticks, "lb", 10_000, 20_000).maxStaleReplicaMs)).toBe(true);
  });
});

describe("transitions", () => {
  test("lists each change of server, starting from start", () => {
    const ticks = [k(0, "lb", "replica"), k(1, "lb", "replica"), k(2, "lb", undefined, undefined, "timeout"), k(3, "lb", "primary"), k(4, "replica", "replica")];
    expect(transitions(ticks, "lb")).toEqual([
      { t: 0, from: "start", to: "replica" },
      { t: 2, from: "replica", to: "timeout" },
      { t: 3, from: "timeout", to: "primary" },
    ]);
  });
});

describe("buckets and errorModes", () => {
  const ticks = [k(0, "lb", "replica", 100), k(4000, "lb", "replica", 300), k(5000, "lb", undefined, undefined, "timeout"), k(6000, "replica", "replica", 9000), k(7000, "lb", undefined, undefined, "timeout"), k(7500, "lb", undefined, undefined, "HTTP 502")];
  test("one line per bucket, sources that had ticks only", () => {
    expect(buckets(ticks, ["lb", "replica"], 5000)).toEqual(["+0s lb R2 P0 E0 max 300ms", "+5s lb R0 P0 E3 | replica R1 P0 E0 max 9000ms"]);
  });
  test("error modes in first-seen order, once each", () => {
    expect(errorModes(ticks, "lb")).toEqual(["timeout", "HTTP 502"]);
  });
});
