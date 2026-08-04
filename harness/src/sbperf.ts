/**
 * Reads the output of `sbperf bench --json`.
 *
 * Why shell out at all: throughput comparison is a methodology problem before
 * it is a measurement problem, and `sbperf bench` already solves the
 * methodology - it refuses to run on a saturated client, runs an unmeasured
 * warmup before N measured repetitions, takes exact percentiles from pgbench's
 * own -l transaction log rather than the rounded stdout summary, snapshots
 * pg_settings per run so two numbers can be shown to have come from the same
 * server configuration, and stores every run so `--compare` is a command rather
 * than an arithmetic exercise. T20's inline `pgbench ... -T 15` +
 * `tps = ([0-9.]+)` regex has none of that.
 *
 * sbperf is a separate public tool, expected on PATH - it is not vendored here,
 * so this module parses only the fields the report needs. An added column
 * upstream must not break a lab run.
 */

export interface BenchSummary {
  /** Row id in sbperf's history store - the handle for `bench --compare`. */
  id: number;
  label: string;
  tpsMedian: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  failedTx: number;
  clients: number;
  timeS: number;
  protocol: string;
  spreadPct: number;
  tainted: boolean;
  clientLoadMax: number;
  clientCores: number;
  serverVersion: string;
  pgbenchVersion: string;
}

function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`sbperf bench --json: ${field} is not a number (${v})`);
  return n;
}

/** us -> ms, two decimals. Percentiles are reported in ms everywhere else here. */
function ms(us: unknown, field: string): number {
  return Math.round(num(us, field) / 10) / 100;
}

export function parseBenchJson(text: string): BenchSummary {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // sbperf's guardrails (busy client, missing pgbench) print prose and exit.
    // Surfacing that prose is the whole point - a bare SyntaxError is not a
    // finding, "client load is 14.2 on 16 cores" is.
    throw new Error(`sbperf bench did not emit JSON: ${text.trim().slice(0, 300)}`);
  }
  const top = doc as { id?: unknown; row?: unknown; tpsSpreadPct?: unknown };
  if (!top.row || typeof top.row !== "object")
    throw new Error(`sbperf bench --json: no "row" object in the output`);
  const r = top.row as Record<string, unknown>;

  return {
    id: num(top.id, "id"),
    label: typeof r.name === "string" ? r.name : "",
    tpsMedian: num(r.tps_median, "row.tps_median"),
    p50Ms: ms(r.p50_us, "row.p50_us"),
    p95Ms: ms(r.p95_us, "row.p95_us"),
    p99Ms: ms(r.p99_us, "row.p99_us"),
    failedTx: num(r.failed_tx, "row.failed_tx"),
    clients: num(r.clients, "row.clients"),
    timeS: num(r.time_s, "row.time_s"),
    protocol: String(r.protocol ?? ""),
    spreadPct: num(top.tpsSpreadPct ?? 0, "tpsSpreadPct"),
    tainted: r.tainted === true,
    clientLoadMax: num(r.client_load_max ?? 0, "row.client_load_max"),
    clientCores: num(r.client_cores ?? 0, "row.client_cores"),
    serverVersion: String(r.server_version ?? ""),
    pgbenchVersion: String(r.pgbench_version ?? ""),
  };
}

/**
 * Reasons this number may not mean what it appears to. Reported next to the
 * number rather than as a footnote: a tainted run measured the client.
 */
export function benchCaveats(s: BenchSummary): string[] {
  const out: string[] = [];
  if (s.tainted)
    out.push(
      `client load peaked at ${s.clientLoadMax} on ${s.clientCores} cores - the CLIENT may be the bottleneck`,
    );
  if (s.spreadPct > 15) out.push(`tps spread ${s.spreadPct}% across runs - unstable`);
  return out;
}

/** Signed percentage difference against a baseline tps. */
export function throughputDelta(baselineTps: number | null, tps: number): string {
  if (!baselineTps) return "n/a";
  const pct = ((tps - baselineTps) / baselineTps) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

export function benchMeasurements(
  s: BenchSummary,
  baselineTps: number | null,
): Record<string, number | string> {
  return {
    tps_median: s.tpsMedian,
    vs_baseline: throughputDelta(baselineTps, s.tpsMedian),
    p50_ms: s.p50Ms,
    p95_ms: s.p95Ms,
    p99_ms: s.p99Ms,
    failed_tx: s.failedTx,
    clients: s.clients,
    protocol: s.protocol,
    tps_spread_pct: s.spreadPct,
    sbperf_run_id: s.id,
  };
}
