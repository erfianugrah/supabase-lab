/**
 * S01 - which Postgres features survive each connection mode.
 *
 * One row per mode, one measurement per feature, so the report's Measurements
 * table IS the matrix a reader uses to predict what a migration costs them.
 * The Evidence section carries every server error verbatim.
 *
 * The direct 5432 row is the CONTROL and the only one that asserts. A feature
 * that fails there means the probe is wrong; a feature that fails only on a
 * pooled row is the finding. Without the control, "cursors do not work on
 * 6543" cannot be distinguished from "the cursor probe is broken".
 *
 * Reachability caveat: the direct endpoint is IPv6-only (AGENTS.md,
 * privatelink-aws T18). From an IPv4-only vantage the control row skips with
 * the connect error and the pooled rows lose their reference - that is
 * reported, never silently absorbed.
 */
import { Client } from "pg";
import {
  regressionVerdict,
  parseTarget,
  renderEvidence,
  runFeatures,
  summariseRow,
  toMeasurements,
  type FeatureOutcome,
  type Target,
} from "../../../harness/src/matrix";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { featuresFor } from "../lib/features";

const CONNECT_TIMEOUT_MS = 10_000;
/** Bounds one measurement cell. The full text always lands in `evidence`. */
const CELL_MAX = 110;

/**
 * Supavisor tenant-username shape. UNVERIFIED here on purpose - Task 7 Step 2
 * reads it off the live project and passes it as PVLAB_ENDPOINT_POOLER_USER.
 */
const poolerUser = (ctx: Ctx) => ctx.endpoints.pooler_user ?? `postgres.${ctx.ref}`;

interface ModeSpec {
  id: string;
  label: string;
  /** ctx.endpoints key; null means the direct host derived from the ref. */
  endpointKey: string | null;
  defaultPort: number;
  user: (ctx: Ctx) => string;
  control: boolean;
}

const MODES: ModeSpec[] = [
  {
    id: "S01a",
    label: "direct 5432 (session, no pooler)",
    endpointKey: null,
    defaultPort: 5432,
    user: () => "postgres",
    control: true,
  },
  {
    id: "S01b",
    label: "pooler session mode",
    endpointKey: "pooler_session",
    defaultPort: 5432,
    user: poolerUser,
    control: false,
  },
  {
    id: "S01c",
    label: "pooler transaction mode",
    endpointKey: "pooler_txn",
    defaultPort: 6543,
    user: poolerUser,
    control: false,
  },
  {
    id: "S01d",
    label: "public shared pooler, transaction mode",
    endpointKey: "shared_txn",
    defaultPort: 6543,
    user: poolerUser,
    control: false,
  },
];

function tagOf(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

async function probeMode(
  ctx: Ctx,
  spec: ModeSpec,
  target: Target,
  advisoryKey: number,
): Promise<{ result: TestResult; outcomes: FeatureOutcome[] }> {
  const user = spec.user(ctx);
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
  } catch (e) {
    await client.end().catch(() => {});
    return {
      outcomes: [],
      result: {
        id: spec.id,
        title: spec.label,
        status: "skip",
        detail: `could not connect to ${target.host}:${target.port} as ${user}: ${
          e instanceof Error ? e.message : String(e)
        }`,
        measurements: { mode: spec.label, host_port: `${target.host}:${target.port}` },
      },
    };
  }

  try {
    const outcomes = await runFeatures(featuresFor(client, tagOf(spec.id), advisoryKey));
    const { status, detail } = summariseRow(outcomes, { control: spec.control });
    return {
      outcomes,
      result: {
        id: spec.id,
        title: spec.label,
        status,
        detail,
        measurements: {
          mode: spec.label,
          host_port: `${target.host}:${target.port}`,
          ...toMeasurements(outcomes, CELL_MAX),
        },
        evidence: renderEvidence(outcomes),
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "S01",
  title: "Pooler feature matrix: what breaks in each connection mode",
  where: "local",
  requires: ["db"],
  async run(ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let txnOutcomes: FeatureOutcome[] = [];
    // Per-run key: in transaction mode the lock leaks onto whichever backend
    // took it, so reusing a constant would eventually block a later run.
    const advisoryKey = Date.now() % 2_000_000_000;

    for (const spec of MODES) {
      const raw = spec.endpointKey === null ? ctx.phzHost : ctx.endpoints[spec.endpointKey];
      let target: Target | null;
      try {
        target = parseTarget(raw, spec.defaultPort);
      } catch (e) {
        results.push({
          id: spec.id,
          title: spec.label,
          status: "fail",
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (!target) {
        // endpointKey is null for the direct row, whose host comes from
        // ctx.phzHost (derived as db.<ref>.supabase.co when PHZ_HOST is unset).
        // Interpolating a null key would print "PVLAB_ENDPOINT_UNDEFINED" and
        // send the reader looking for a variable that does not exist.
        results.push({
          id: spec.id,
          title: spec.label,
          status: "skip",
          detail: spec.endpointKey
            ? `no PVLAB_ENDPOINT_${spec.endpointKey.toUpperCase()} supplied - see the Makefile's pooler-config target`
            : "no direct host: PVLAB_REF and PHZ_HOST are both unset",
        });
        continue;
      }

      ctx.log(`${spec.id} ${spec.label} -> ${target.host}:${target.port}`);
      const { result, outcomes } = await probeMode(ctx, spec, target, advisoryKey);
      results.push(result);
      if (spec.id === "S01c") txnOutcomes = outcomes;
    }

    // The pin. AGENTS.md and privatelink-aws T11 record server-side prepared
    // statements MEASURED ok on 6543, against the widely repeated rule that
    // transaction mode forbids them. Re-measured every run so a platform
    // change lands as one loud fail rather than one quiet cell.
    const first = txnOutcomes.find((o) => o.name === "prepared_first");
    const prior = { label: "T11 / AGENTS.md (prepared statements ok on 6543)", ok: true };
    const verdict = regressionVerdict(first, prior);
    results.push({
      id: "S01e",
      title: "Prepared statements on the dedicated pooler, re-measured against the recorded result",
      status: verdict.status,
      detail: verdict.detail,
      measurements: {
        prior_result: "ok (T11)",
        this_run: first ? (first.ok ? "ok" : `failed: ${first.error.slice(0, CELL_MAX)}`) : "n/a",
      },
    });

    return results;
  },
};
export default mod;
