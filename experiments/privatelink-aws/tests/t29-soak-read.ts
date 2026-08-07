/**
 * T29 - read and summarise the PgBouncer soak. Does NOT run the soak: the
 * EventBridge schedule and the probe Lambda's S3 writes (soak.tf,
 * lambda/index.mjs, `enable_soak`) are the soak. This test only reads what
 * has accumulated in the suite bucket - the same bucket suite.sh already
 * creates for run artifacts, reused under a soak/ prefix rather than
 * inventing a second bucket - and reports on it.
 *
 * Specifically:
 *   - how long the soak has been running (oldest to newest record timestamp)
 *   - connect success rate over the run, split early vs late rather than one
 *     overall rate - a slow-building refusal averages itself out in a single
 *     number
 *   - latency drift between the early and late halves of the run
 *   - whether `max_client_conn` refusals appear, and how far into the run
 *     they first show up - the question the whole soak exists to answer
 *   - the long-idle probe's own numbers (see lambda/index.mjs's probeIdle):
 *     how often the held connection was actually reused across ticks, which
 *     is opportunistic (execution-environment reuse is not guaranteed) and
 *     reported as such, not as a controlled result
 *
 * With zero records this SKIPS - there is nothing to summarise, and
 * reporting a clean run from no data would be worse than saying nothing.
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

interface SoakRecord {
  ts: string;
  kind?: string;
  ok: boolean;
  connect_ms?: number;
  reused?: boolean;
  error?: string;
}

async function aws(args: string[]): Promise<string> {
  return await $`aws ${args}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow()
    .text()
    .catch(() => "");
}

async function accountId(): Promise<string> {
  return (await aws(["sts", "get-caller-identity", "--query", "Account", "--output", "text"])).trim();
}

/** Bounded so a months-long soak cannot make this test read an unbounded
 * amount of S3 - duration, drift, and refusal onset all come from ordering,
 * not from every single record, so the most recent slice is enough. */
const MAX_RECORDS = 2000;

async function listKeys(bucket: string, region: string): Promise<string[]> {
  const out = await aws([
    "s3api", "list-objects-v2", "--bucket", bucket, "--prefix", "soak/",
    "--region", region, "--query", "Contents[].Key", "--output", "json",
  ]);
  try {
    const keys = JSON.parse(out || "[]") as (string | null)[];
    return keys
      .filter((k): k is string => !!k)
      .sort()
      .slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

async function getRecord(bucket: string, key: string, region: string): Promise<SoakRecord | null> {
  const out = await aws(["s3", "cp", `s3://${bucket}/${key}`, "-", "--region", region]);
  try {
    const j = JSON.parse(out) as Partial<SoakRecord>;
    if (typeof j.ts !== "string" || typeof j.ok !== "boolean") return null;
    return j as SoakRecord;
  } catch {
    return null;
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const mod: TestModule = {
  id: "T29",
  title: "PgBouncer soak - read and summarise the accumulated records",
  where: "local",
  requires: ["endpoint"],
  async run(ctx: Ctx): Promise<TestResult> {
    const account = await accountId();
    if (!account) {
      return {
        id: "T29",
        title: mod.title,
        status: "skip",
        detail: "could not resolve an AWS account id (no AWS credentials in this environment) - cannot locate the soak bucket",
      };
    }

    const bucket = `supabase-lab-suite-${account}`;
    const keys = await listKeys(bucket, ctx.region);
    if (!keys.length) {
      return {
        id: "T29",
        title: mod.title,
        status: "skip",
        detail: `no soak records under s3://${bucket}/soak/ - enable_soak is off, the schedule hasn't ticked yet, or the bucket doesn't exist`,
      };
    }

    const records: SoakRecord[] = [];
    for (const key of keys) {
      const r = await getRecord(bucket, key, ctx.region);
      if (r) records.push(r);
    }
    if (!records.length) {
      return {
        id: "T29",
        title: mod.title,
        status: "skip",
        detail: `${keys.length} object(s) found under soak/ but none parsed as a soak record`,
      };
    }

    records.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = records[0]!;
    const last = records[records.length - 1]!;
    const runningMs = Date.parse(last.ts) - Date.parse(first.ts);
    const runningHours = runningMs > 0 ? runningMs / 3_600_000 : 0;

    const fresh = records.filter((r) => r.kind !== "idle");
    const idle = records.filter((r) => r.kind === "idle");

    const half = Math.floor(fresh.length / 2) || 1;
    const early = fresh.slice(0, half);
    const late = fresh.slice(half);

    const successRate = (rs: SoakRecord[]) => (rs.length ? rs.filter((r) => r.ok).length / rs.length : 0);
    const earlyRate = successRate(early);
    const lateRate = successRate(late);

    const earlyLatency = median(early.filter((r) => r.ok && r.connect_ms != null).map((r) => r.connect_ms!));
    const lateLatency = median(late.filter((r) => r.ok && r.connect_ms != null).map((r) => r.connect_ms!));

    const refusals = fresh.filter((r) => !r.ok && /max_client_conn/i.test(r.error ?? ""));
    const firstRefusal = refusals[0];
    const firstRefusalAgeMs = firstRefusal ? Date.parse(firstRefusal.ts) - Date.parse(first.ts) : null;

    const idleReused = idle.filter((r) => r.reused === true).length;

    return {
      id: "T29",
      title: mod.title,
      status: "info",
      detail:
        refusals.length > 0
          ? `${refusals.length} max_client_conn refusal(s) over ${fresh.length} fresh-connect records spanning ${runningHours.toFixed(1)}h - first at +${Math.round((firstRefusalAgeMs ?? 0) / 60000)}min`
          : `no max_client_conn refusals across ${fresh.length} fresh-connect records spanning ${runningHours.toFixed(1)}h`,
      measurements: {
        records_total: records.length,
        records_fresh: fresh.length,
        records_idle: idle.length,
        running_hours: Number(runningHours.toFixed(2)),
        success_rate_early: Number(earlyRate.toFixed(3)),
        success_rate_late: Number(lateRate.toFixed(3)),
        latency_ms_median_early: earlyLatency ?? "n/a",
        latency_ms_median_late: lateLatency ?? "n/a",
        max_client_conn_refusals: refusals.length,
        first_refusal_age_min: firstRefusalAgeMs !== null ? Math.round(firstRefusalAgeMs / 60000) : "none",
        idle_probes: idle.length,
        idle_reused: idleReused,
      },
      evidence: `first: ${JSON.stringify(first)}\nlast: ${JSON.stringify(last)}`,
    };
  },
};
export default mod;
