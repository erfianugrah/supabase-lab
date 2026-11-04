import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorLines, flatten, JARS, JDK_IMAGE, stderrKinds } from "./java";

// Synthetic fixture: every number below is made up for the arithmetic, not a measurement.
const summary = {
  e: "summary",
  wall_ms: 1234,
  wall_cap_hit: false,
  threads: 12,
  first_error_ms: 87,
  wrong_results: 0,
  backend_pid_samples: 100,
  backend_switches: 40,
  distinct_backend_pids: 9,
  ops: {
    select: { ok: 98, fail: 2, p50_ms: 70.1, p95_ms: 80, p99_ms: 90, max_ms: 95 },
    iteration: { ok: 98, fail: 2, p50_ms: 400, p95_ms: 500, p99_ms: 600, max_ms: 700 },
    update_txn: { ok: 0, fail: 100, p50_ms: -1, p95_ms: -1, p99_ms: -1, max_ms: -1 },
  },
  throughput_iter_per_s: 79.4,
  error_kinds: 2,
  errors: [
    { op: "select", class: "PSQLException", sqlstate: "26000", count: 2, first_at_ms: 87, elapsed_min_ms: 70.4, elapsed_max_ms: 75.6, example: 'PSQLException [26000]: ERROR: prepared statement "S_1" does not exist' },
    { op: "connect", class: "PSQLException", sqlstate: "XX000", count: 1, first_at_ms: 10, elapsed_min_ms: 500, elapsed_max_ms: 500, example: "x" },
  ],
  pools: [
    { instance: 0, init_error: "", fill_ms: 100, total_at_start: 3, connect_attempts: 3, connect_failures: 0, connect_p50_ms: 1, connect_max_ms: 2, hikari_timeouts: 0 },
    { instance: 1, init_error: "PoolInitializationException: x", fill_ms: -1, total_at_start: -1, connect_attempts: 2, connect_failures: 2, connect_p50_ms: -1, connect_max_ms: -1, hikari_timeouts: 1 },
  ],
};

describe("flatten", () => {
  const f = flatten(summary);
  test("ops become prefixed columns; percentiles only where something succeeded", () => {
    expect(f.select_ok).toBe(98);
    expect(f.select_p99_ms).toBe(90);
    expect(f.update_txn_fail).toBe(100);
    expect("update_txn_p50_ms" in f).toBe(false);
  });
  test("pools are summed, init errors counted, totals listed per instance", () => {
    expect(f.connect_attempts).toBe(5);
    expect(f.connect_failures).toBe(2);
    expect(f.hikari_timeouts).toBe(1);
    expect(f.pool_init_errors).toBe(1);
    expect(f.pool_totals_at_start).toBe("3/-1");
  });
  test("workload fields carried", () => {
    expect(f.throughput_iter_per_s).toBe(79.4);
    expect(f.backend_switches).toBe(40);
    expect(f.wall_cap_hit).toBe("no");
  });
  test("a hold summary has no workload columns", () => {
    const h = flatten({ ...summary, ops: { hold_exec: { ok: 1, fail: 0, p50_ms: 1, p95_ms: 1, p99_ms: 1, max_ms: 1 } } });
    expect("backend_switches" in h).toBe(false);
    expect("throughput_iter_per_s" in h).toBe(false);
  });
});

describe("errorLines", () => {
  test("count, op, class, state, rounded elapsed range, example", () => {
    expect(errorLines(summary.errors as never, 1)).toBe(
      '2x select PSQLException [26000] (70-76 ms): PSQLException [26000]: ERROR: prepared statement "S_1" does not exist',
    );
  });
  test("empty is empty", () => expect(errorLines([])).toBe(""));
});

describe("stderrKinds", () => {
  test("groups WARN/ERROR lines with digits folded", () => {
    const s = [
      "2026-11-04 10:00:01:123 [app0 connection adder] WARN com.zaxxer.hikari.pool.HikariPool - app0 - Connection add failed after 512ms",
      "2026-11-04 10:00:02:456 [app0 connection adder] WARN com.zaxxer.hikari.pool.HikariPool - app0 - Connection add failed after 1024ms",
      "some INFO line",
    ].join("\n");
    const k = stderrKinds(s);
    expect(k.warn_lines).toBe(2);
    expect(k.top).toBe("2x WARN com.zaxxer.hikari.pool.HikariPool - appN - Connection add failed after Nms");
  });
});

describe("pins", () => {
  test("image pinned by digest, jars by sha256, the probe reads the password from its environment", () => {
    expect(JDK_IMAGE).toMatch(/^eclipse-temurin:[\w.-]+@sha256:[0-9a-f]{64}$/);
    for (const j of JARS) expect(j.sha256).toMatch(/^[0-9a-f]{64}$/);
    const probe = readFileSync(resolve(import.meta.dir, "../drivers/java/Probe.java"), "utf8");
    expect(probe).toContain('System.getenv("PGPASSWORD")');
  });
});
