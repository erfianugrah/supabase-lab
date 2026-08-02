/**
 * T20 - connect latency and throughput per path.
 *
 * Percentiles are computed here rather than in hand-written awk (the bash
 * version sorted with an insertion sort inline). pgbench is still the right
 * tool for throughput, so it is wrapped and parsed rather than reimplemented.
 *
 * Note on "public-direct": the runner's resolver maps the database hostname to
 * the endpoint via the PHZ, so reaching the public address requires resolving
 * it externally and pinning it. Without the IPv4 add-on there is no A record
 * at all, which is itself recorded rather than silently skipped.
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const N = Number(process.env.PVLAB_CONNECTS ?? 30);
const BENCH_SECS = Number(process.env.PVLAB_BENCH_SECS ?? 15);

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i]!;
}

async function connectSeries(
  ctx: Ctx,
  host: string,
  port: number,
  user: string,
): Promise<{ samples: number[]; fails: number }> {
  const samples: number[] = [];
  let fails = 0;
  for (let i = 0; i < N; i++) {
    const c = new Client({
      host,
      port,
      user,
      database: "postgres",
      password: ctx.dbPassword,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    const t0 = performance.now();
    try {
      await c.connect();
      await c.query("select 1");
      samples.push(Math.round(performance.now() - t0));
    } catch {
      fails++;
    } finally {
      await c.end().catch(() => {});
    }
  }
  return { samples: samples.sort((a, b) => a - b), fails };
}

async function pgbench(ctx: Ctx, conn: string): Promise<{ tps: number; latMs: number } | null> {
  if (!ctx.capabilities.has("pgbench")) return null;
  await Bun.write("/tmp/pvlab-bench.sql", "select 1;\n");
  const out = await $`pgbench ${conn} -f /tmp/pvlab-bench.sql -c 4 -j 2 -T ${BENCH_SECS} --no-vacuum`
    .env({ ...process.env, PGPASSWORD: ctx.dbPassword, PGCONNECT_TIMEOUT: "10" })
    .quiet()
    .nothrow()
    .text();
  const tps = Number(out.match(/tps = ([0-9.]+)/)?.[1] ?? 0);
  const latMs = Number(out.match(/latency average = ([0-9.]+)/)?.[1] ?? 0);
  return tps ? { tps, latMs } : null;
}

const mod: TestModule = {
  id: "T20",
  title: "Connect latency and throughput per path",
  where: "runner",
  requires: ["db"],
  async run(ctx) {
    const results: TestResult[] = [];

    // Public address, resolved outside the VPC resolver so the PHZ does not
    // shadow it. No A record = no public IPv4 path, which is a finding.
    const publicIp = (
      await $`dig +short @8.8.8.8 ${ctx.phzHost} A`.quiet().nothrow().text()
    )
      .split("\n")
      .find((l) => /^[0-9.]+$/.test(l.trim()));

    const paths: Array<{ id: string; label: string; host: string; port: number; user: string }> = [
      { id: "T20a", label: "private-5432", host: ctx.phzHost, port: 5432, user: "postgres" },
      { id: "T20b", label: "private-6543", host: ctx.phzHost, port: 6543, user: "postgres" },
    ];
    if (publicIp) {
      paths.push({
        id: "T20c",
        label: "public-direct-5432",
        host: publicIp,
        port: 5432,
        user: "postgres",
      });
    } else {
      results.push({
        id: "T20c",
        title: "public-direct-5432",
        status: "info",
        detail:
          "no public A record for the database host - without the IPv4 add-on there is no public-direct path to measure",
      });
    }

    for (const p of paths) {
      const { samples, fails } = await connectSeries(ctx, p.host, p.port, p.user);
      const bench = await pgbench(
        ctx,
        `host=${p.host} port=${p.port} user=${p.user} dbname=postgres sslmode=require`,
      );
      results.push({
        id: p.id,
        title: `${p.label} latency`,
        status: samples.length ? "info" : "fail",
        detail: samples.length
          ? `${samples.length}/${N} connects ok`
          : `all ${N} connects failed`,
        measurements: {
          path: p.label,
          min_ms: samples[0] ?? 0,
          p50_ms: pct(samples, 0.5),
          p95_ms: pct(samples, 0.95),
          max_ms: samples[samples.length - 1] ?? 0,
          fails,
          ...(bench ? { tps: Math.round(bench.tps), bench_lat_ms: bench.latMs } : {}),
        },
      });
    }
    return results;
  },
};
export default mod;
