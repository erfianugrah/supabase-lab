import { describe, expect, test } from "bun:test";
import { benchCaveats, benchMeasurements, parseBenchJson, throughputDelta } from "./sbperf";

/**
 * Shaped from sbperf's own types (src/bench.ts `BenchResult`, src/store.ts
 * `BenchRunInput`): `bench --json` prints JSON.stringify(res, null, 2) where
 * res = { id, row, runs, tpsSpreadPct }. Only the fields read below are
 * asserted on, so an added column upstream does not break this. The numbers
 * are invented - this test pins the parser, not the platform.
 */
const SAMPLE = JSON.stringify({
  id: 12,
  row: {
    ref: "abcdefghijklmnopqrst",
    ts: 1785500000,
    name: "direct-5432",
    script_hash: "9f2c",
    scale: 1,
    clients: 8,
    threads: 4,
    time_s: 60,
    protocol: "extended",
    rate: null,
    tps_median: 3810.42,
    p50_us: 2010,
    p95_us: 5400,
    p99_us: 11250,
    failed_tx: 0,
    client_cores: 16,
    client_load_max: 3.2,
    tainted: false,
    unstable: false,
    pgbench_version: "16.4",
    server_version: "15.8",
  },
  runs: [{ tps: 3800 }, { tps: 3810 }, { tps: 3822 }],
  tpsSpreadPct: 0.6,
});

describe("parseBenchJson", () => {
  test("pulls the scalars and converts microseconds to milliseconds", () => {
    const s = parseBenchJson(SAMPLE);
    expect(s.id).toBe(12);
    expect(s.tpsMedian).toBe(3810.42);
    expect(s.p95Ms).toBe(5.4);
    expect(s.p99Ms).toBe(11.25);
    expect(s.clients).toBe(8);
    expect(s.protocol).toBe("extended");
    expect(s.serverVersion).toBe("15.8");
  });

  test("non-JSON stdout throws WITH the output, not a bare SyntaxError", () => {
    // sbperf refuses to run on a busy client; that message must reach the report
    // instead of being swallowed as "unexpected token".
    expect(() => parseBenchJson("client load is 14.2 on 16 cores - a busy client")).toThrow(
      /busy client/,
    );
  });

  test("JSON of the wrong shape throws rather than yielding NaN columns", () => {
    expect(() => parseBenchJson('{"ok":true}')).toThrow(/row/);
  });
});

describe("benchCaveats", () => {
  test("a clean run has none", () => {
    expect(benchCaveats(parseBenchJson(SAMPLE))).toEqual([]);
  });

  test("client saturation and tps spread are reported separately", () => {
    const dirty = JSON.parse(SAMPLE) as { row: Record<string, unknown>; tpsSpreadPct: number };
    dirty.row.tainted = true;
    dirty.row.client_load_max = 22.5;
    dirty.tpsSpreadPct = 21.4;
    dirty.row.unstable = true;
    const c = benchCaveats(parseBenchJson(JSON.stringify(dirty)));
    expect(c).toHaveLength(2);
    expect(c[0]).toContain("22.5");
    expect(c[1]).toContain("21.4");
  });
});

describe("throughputDelta", () => {
  test("slower than the baseline reads negative", () => {
    expect(throughputDelta(3810, 2258)).toBe("-40.7%");
  });

  test("faster reads positive with a sign", () => {
    expect(throughputDelta(2000, 2500)).toBe("+25.0%");
  });

  test("the baseline against itself is exactly zero", () => {
    expect(throughputDelta(3810, 3810)).toBe("+0.0%");
  });

  test("a zero or absent baseline is n/a, not Infinity", () => {
    // The direct row skips when there is no IPv6 path out of this vantage,
    // which would otherwise make every pooled delta read "Infinity%".
    expect(throughputDelta(0, 2258)).toBe("n/a");
    expect(throughputDelta(null, 2258)).toBe("n/a");
  });
});

describe("benchMeasurements", () => {
  test("flattens to scalar report columns, baseline delta included", () => {
    const m = benchMeasurements(parseBenchJson(SAMPLE), 4500);
    expect(m.tps_median).toBe(3810.42);
    expect(m.p95_ms).toBe(5.4);
    expect(m.vs_baseline).toBe("-15.3%");
    expect(m.clients).toBe(8);
    expect(m.sbperf_run_id).toBe(12);
  });

  test("without a baseline the delta column says so instead of vanishing", () => {
    // A missing column silently drops the row out of the comparison table.
    expect(benchMeasurements(parseBenchJson(SAMPLE), null).vs_baseline).toBe("n/a");
  });
});
