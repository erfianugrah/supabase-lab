import { describe, expect, test } from "bun:test";
import {
  attrsReached,
  diskDelta,
  failureLines,
  maxOkGapMs,
  mbps,
  minSizeGbForIops,
  nextAllowedMs,
  parseCooldown,
  parseNodeMetrics,
  pathPhaseStats,
  phaseAt,
  quantile,
  retryMinutes,
  type PathSample,
} from "./disk-change";

describe("gp3 sizing", () => {
  test("the D11 floor: 3,000 IOPS needs 6 GB, 6,000 needs 12 GB", () => {
    expect(minSizeGbForIops(3000)).toBe(6);
    expect(minSizeGbForIops(1000)).toBe(6);
    expect(minSizeGbForIops(6000)).toBe(12);
    expect(minSizeGbForIops(6001)).toBe(13);
  });
  test("attrsReached compares only the keys the target sets", () => {
    expect(attrsReached({ type: "gp3", size_gb: 24, iops: 6000, throughput_mibps: 250 }, { iops: 6000, throughput_mibps: 250 })).toBe(true);
    expect(attrsReached({ type: "gp3", size_gb: 24, iops: 3000, throughput_mibps: 250 }, { iops: 6000, throughput_mibps: 250 })).toBe(false);
    expect(attrsReached(undefined, { iops: 1 })).toBe(false);
  });
});

describe("parseCooldown", () => {
  test("the D03 message, ISO timestamp, inside a JSON body", () => {
    const c = parseCooldown(JSON.stringify({ message: "Database disk can only be modified once per four hours. Last modified at 2026-10-01T00:09:13.123Z" }));
    expect(c.hours).toBe(4);
    expect(c.lastModifiedMs).toBe(Date.parse("2026-10-01T00:09:13.123Z"));
    expect(nextAllowedMs(c, 0)).toBe(Date.parse("2026-10-01T04:09:13.123Z"));
  });
  test("the 2026-11-04 refusal: day-month-year, not month-day", () => {
    const c = parseCooldown('{"message":"Database disk can only be modified once per four hours. Last modified at 04-11-2026 09:35:09 UTC"}');
    expect(c.hours).toBe(4);
    expect(c.lastModifiedText).toBe("04-11-2026 09:35:09 UTC");
    expect(new Date(c.lastModifiedMs as number).toISOString()).toBe("2026-11-04T09:35:09.000Z");
    expect(new Date(nextAllowedMs(c, 0)).toISOString()).toBe("2026-11-04T13:35:09.000Z");
  });
  test("plain text, digit hours, trailing sentence", () => {
    const c = parseCooldown("Database disk can only be modified once per 6 hours. Last modified at 2026-11-04 01:02:03+00:00. Try later.");
    expect(c.hours).toBe(6);
    expect(c.lastModifiedMs).toBe(Date.parse("2026-11-04T01:02:03+00:00"));
  });
  test("an unparseable time falls back to the caller's start and four hours", () => {
    const c = parseCooldown("Database disk can only be modified once per four hours. Last modified at sometime");
    expect(c.lastModifiedMs).toBeNull();
    expect(c.lastModifiedText).toBe("sometime");
    expect(nextAllowedMs(c, 1000)).toBe(1000 + 4 * 3_600_000);
  });
  test("a body with neither", () => {
    const c = parseCooldown('{"message":"Too many requests"}');
    expect(c).toEqual({ hours: null, lastModifiedMs: null, lastModifiedText: "" });
  });
  test("retryMinutes reads the add-on refusal", () => {
    expect(retryMinutes("We are still processing addon changes, please try again in 3 minute(s)")).toBe(3);
    expect(retryMinutes("nope")).toBeNull();
  });
});

const S = (at: number, ok: boolean, ms = 10, error?: string): PathSample => ({ at, ok, ms, ...(error ? { error } : {}) });

describe("per-phase path statistics", () => {
  const phases = [
    { name: "baseline", startMs: 0 },
    { name: "change", startMs: 10_000 },
    { name: "tail", startMs: 20_000 },
  ];
  // 1 s cadence; the change phase drops samples 12..15 (4 failures), recovery at 16.
  const samples: PathSample[] = [];
  for (let t = 0; t < 30; t++) samples.push(S(t * 1000, !(t >= 12 && t <= 15), 10 + t, t >= 12 && t <= 15 ? "ECONNREFUSED" : undefined));

  test("gaps: a success-to-success gap spans the outage plus one interval", () => {
    expect(maxOkGapMs(samples, 10_000, 20_000)).toBe(5000);
    expect(maxOkGapMs(samples, 0, 10_000)).toBe(1000);
    expect(maxOkGapMs([S(0, true), S(1000, false)], 500, 2000)).toBe(2000); // no success in the window: still down at its end
  });

  test("outage attributed to the change phase, nothing in baseline or tail", () => {
    const st = pathPhaseStats(samples, phases, 30_000);
    expect(st.map((s) => s.phase)).toEqual(["baseline", "change", "tail"]);
    expect(st[0]).toMatchObject({ samples: 10, failures: 0, outages: 0, maxOutageS: 0, maxGapS: 1 });
    expect(st[1]).toMatchObject({ samples: 10, failures: 4, outages: 1, maxOutageS: 4, maxGapS: 5, firstFailS: 2 });
    expect(st[2]).toMatchObject({ failures: 0, maxGapS: 1 });
    expect(st[1]?.maxMs).toBe(29); // OK samples in change: t = 10, 11, 16..19 -> ms 20, 21, 26..29
    expect(st[1]?.p50Ms).toBe(26);
  });

  test("failure lines carry time, phase and error, and are capped", () => {
    const lines = failureLines("direct", samples, phases, 0, 2);
    expect(lines[0]).toMatch(/^\+12\.000s 1970-01-01T00:00:12\.000Z direct \[change\] 22ms ECONNREFUSED$/);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("direct: 2 more failures not listed");
    expect(phaseAt(phases, -1)).toBe("");
  });

  test("quantile", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });
});

describe("node metrics", () => {
  const a = parseNodeMetrics(
    [
      "# HELP node_time_seconds x",
      "node_time_seconds 1000",
      'node_disk_written_bytes_total{device="nvme0n1"} 1e6',
      'node_disk_written_bytes_total{device="nvme1n1"} 1e9',
      'node_disk_writes_completed_total{device="nvme1n1"} 5000',
      'node_cpu_seconds_total{cpu="0",mode="idle"} 100',
      'node_cpu_seconds_total{cpu="0",mode="user"} 50',
      'node_cpu_seconds_total{cpu="0",mode="steal"} 7',
    ].join("\n"),
  );
  const b = parseNodeMetrics(
    [
      "node_time_seconds 1040",
      'node_disk_written_bytes_total{device="nvme0n1"} 2e6',
      'node_disk_written_bytes_total{device="nvme1n1"} 5e9',
      'node_disk_writes_completed_total{device="nvme1n1"} 25000',
      'node_cpu_seconds_total{cpu="0",mode="idle"} 110',
      'node_cpu_seconds_total{cpu="0",mode="user"} 80',
      'node_cpu_seconds_total{cpu="0",mode="steal"} 9',
    ].join("\n"),
  );
  test("parse", () => {
    expect(a.timeS).toBe(1000);
    expect(a.disks.nvme1n1?.writtenBytes).toBe(1e9);
    expect(a.cpuBusyS).toBe(50);
    expect(a.cpuIdleS).toBe(100);
  });
  test("delta picks the busiest device and averages over the snapshot window", () => {
    expect(diskDelta(a, b)).toEqual({ device: "nvme1n1", seconds: 40, writtenMB: 4000, writes: 20000, writeMBps: 100, writeIops: 500, cpuBusyFrac: 0.75 });
    expect(diskDelta(b, a)).toBeNull();
  });
  test("mbps", () => {
    expect(mbps(4e9, 32_000)).toBe(125);
    expect(mbps(1, 0)).toBe(-1);
  });
});
