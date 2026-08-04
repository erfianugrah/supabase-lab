/**
 * S02 - throughput on identical hardware: direct 5432 vs the dedicated pooler
 * on 6543 vs the public shared pooler.
 *
 * DESTRUCTIVE: sustained load for minutes, against pgbench_* tables that
 * `make bench-init` created by dropping whatever was there.
 *
 * The benchmark is NOT implemented here. `sbperf bench` already carries the
 * methodology - it refuses to run on a saturated client, warms up before N
 * measured repetitions, takes percentiles from pgbench's -l transaction log
 * instead of the rounded stdout line, snapshots pg_settings per run so two
 * numbers can be shown to come from the same server configuration, and keeps a
 * run history that `sbperf bench --compare <a> <b>` reads. This module picks
 * the targets, shells out once per target, and flattens the result.
 *
 * Every row runs the SAME script at the SAME client count against the SAME
 * project. The only variable is the path.
 */
import { $ } from "bun";
import { Client } from "pg";
import { benchCaveats, benchMeasurements, parseBenchJson } from "../../../harness/src/sbperf";
import { parseTarget, type Target } from "../../../harness/src/matrix";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const BUILTIN = process.env.PVLAB_BENCH_BUILTIN ?? "select-only";
const CLIENTS = Number(process.env.PVLAB_BENCH_CLIENTS ?? 8);
const TIME_S = Number(process.env.PVLAB_BENCH_TIME_S ?? 60);
const RUNS = Number(process.env.PVLAB_BENCH_RUNS ?? 3);
const WARMUP_S = Number(process.env.PVLAB_BENCH_WARMUP_S ?? 10);
/**
 * Also bench the transaction pooler with pgbench's PREPARED protocol, which is
 * the throughput consequence of S01's prepared_reuse column. Off by default:
 * it adds one full target's wall clock.
 */
const ALSO_PREPARED = process.env.PVLAB_BENCH_PREPARED === "1";
const CONNECT_TIMEOUT_MS = 10_000;

const poolerUser = (ctx: Ctx) => ctx.endpoints.pooler_user ?? `postgres.${ctx.ref}`;

interface BenchTarget {
  id: string;
  label: string;
  endpointKey: string | null;
  defaultPort: number;
  user: (ctx: Ctx) => string;
  protocol: string;
}

const TARGETS: BenchTarget[] = [
  {
    id: "S02a",
    label: "direct-5432",
    endpointKey: null,
    defaultPort: 5432,
    user: () => "postgres",
    protocol: "extended",
  },
  {
    id: "S02b",
    label: "dedicated-pooler-6543",
    endpointKey: "pooler_txn",
    defaultPort: 6543,
    user: poolerUser,
    protocol: "extended",
  },
  {
    id: "S02c",
    label: "shared-pooler-6543",
    endpointKey: "shared_txn",
    defaultPort: 6543,
    user: poolerUser,
    protocol: "extended",
  },
];

function connString(target: Target, user: string, password: string): string {
  // sbperf splits this with `new URL()`, so both parts must be encoded: a
  // pooler username contains a dot and a generated password can contain
  // anything.
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${target.host}:${target.port}/postgres`;
}

/** Connect once before spending a benchmark's wall clock on an unreachable path. */
async function reachable(
  ctx: Ctx,
  target: Target,
  user: string,
): Promise<{ ok: true; hasPgbenchTables: boolean } | { ok: false; error: string }> {
  const client = new Client({
    host: target.host,
    port: target.port,
    user,
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const r = await client.query<{ t: string | null }>(
      "select to_regclass('public.pgbench_accounts')::text as t",
    );
    return { ok: true, hasPgbenchTables: Boolean(r.rows[0]?.t) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "S02",
  title: "Throughput: direct 5432 vs dedicated pooler vs public shared pooler",
  where: "local",
  requires: ["db", "pgbench"],
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const bin = process.env.PVLAB_SBPERF ?? Bun.which("sbperf");
    if (!bin)
      return [
        {
          id: "S02",
          title: mod.title,
          status: "skip",
          detail:
            "sbperf not on PATH - install it or set PVLAB_SBPERF=/path/to/sbperf. This module deliberately does not hand-roll a benchmark.",
        },
      ];

    const plan = [...TARGETS];
    if (ALSO_PREPARED) {
      const txn = TARGETS.find((t) => t.id === "S02b");
      if (txn)
        plan.push({
          ...txn,
          id: "S02d",
          label: "dedicated-pooler-6543-prepared",
          protocol: "prepared",
        });
    }

    const results: TestResult[] = [];
    let baselineTps: number | null = null;

    for (const t of plan) {
      const raw = t.endpointKey === null ? ctx.phzHost : ctx.endpoints[t.endpointKey];
      let target: Target | null;
      try {
        target = parseTarget(raw, t.defaultPort);
      } catch (e) {
        results.push({
          id: t.id,
          title: t.label,
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (!target) {
        results.push({
          id: t.id,
          title: t.label,
          status: "skip",
          detail: t.endpointKey
            ? `no PVLAB_ENDPOINT_${t.endpointKey.toUpperCase()} supplied`
            : "no direct host: PVLAB_REF and PHZ_HOST are both unset",
        });
        continue;
      }

      const user = t.user(ctx);
      const pre = await reachable(ctx, target, user);
      if (!pre.ok) {
        results.push({
          id: t.id,
          title: t.label,
          status: "skip",
          detail: `unreachable from this vantage (${target.host}:${target.port} as ${user}): ${pre.error}`,
          measurements: { path: t.label },
        });
        continue;
      }
      if (!pre.hasPgbenchTables) {
        results.push({
          id: t.id,
          title: t.label,
          status: "skip",
          detail: "no pgbench_accounts table - run 'make bench-init' once before benching",
          measurements: { path: t.label },
        });
        continue;
      }

      ctx.log(`${t.id} ${t.label}: ${RUNS}x${TIME_S}s + ${WARMUP_S}s warmup, ${CLIENTS} clients`);
      const url = connString(target, user, ctx.dbPassword);
      const args = [
        "bench",
        "--db-url", url,
        "--ref", ctx.ref,
        "--builtin", BUILTIN,
        "--clients", String(CLIENTS),
        "--time", String(TIME_S),
        "--runs", String(RUNS),
        "--warmup", String(WARMUP_S),
        "--protocol", t.protocol,
        "--name", `${ctx.ref}-${t.label}`,
        "--json",
      ];
      if (process.env.PVLAB_BENCH_STORE) args.push("--store", process.env.PVLAB_BENCH_STORE);

      // sbperf spawns pgbench with `{...process.env, PGPASSWORD}`, so PGSSLMODE
      // set here reaches pgbench. --yes is deliberately NOT passed: it would
      // disable the busy-client refusal, which is one of the guardrails this
      // module exists to inherit.
      const proc = await $`${bin} ${args}`
        .env({ ...process.env, PGSSLMODE: "require" })
        .quiet()
        .nothrow();
      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString().trim();

      if (proc.exitCode !== 0) {
        results.push({
          id: t.id,
          title: t.label,
          status: "fail",
          detail: `sbperf bench exited ${proc.exitCode}: ${stderr.split("\n").at(-1) ?? "no stderr"}`,
          evidence: stderr,
          measurements: { path: t.label },
        });
        continue;
      }

      let summary: ReturnType<typeof parseBenchJson>;
      try {
        summary = parseBenchJson(stdout);
      } catch (e) {
        results.push({
          id: t.id,
          title: t.label,
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
          evidence: stderr,
          measurements: { path: t.label },
        });
        continue;
      }

      if (t.id === "S02a") baselineTps = summary.tpsMedian;
      const caveats = benchCaveats(summary);
      results.push({
        id: t.id,
        title: t.label,
        // info, not pass: a throughput number is a measurement, and slower is
        // not a defect. A caveated run is the exception - it may not be a
        // measurement of the database at all.
        status: caveats.length ? "fail" : "info",
        detail: caveats.length
          ? `result not usable: ${caveats.join("; ")}`
          : `${summary.tpsMedian} tps median over ${RUNS}x${TIME_S}s, p95 ${summary.p95Ms} ms`,
        measurements: { path: t.label, ...benchMeasurements(summary, baselineTps) },
        evidence: [
          `server ${summary.serverVersion}, pgbench ${summary.pgbenchVersion}`,
          `script ${BUILTIN}, protocol ${t.protocol}, clients ${CLIENTS}`,
          `sbperf run id ${summary.id} - 'sbperf bench --show ${summary.id}' for the pg_settings snapshot`,
          ...(stderr ? [stderr] : []),
        ].join("\n"),
      });
    }

    return results;
  },
};
export default mod;
