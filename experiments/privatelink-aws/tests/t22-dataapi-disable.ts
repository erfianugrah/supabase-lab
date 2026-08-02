/**
 * T22 - turn the Data API OFF and measure what that actually costs.
 *
 * The docs say the toggle exists ("With the Data API disabled, none of the
 * auto-generated REST endpoints respond, regardless of grants or RLS" -
 * /docs/supabase/guides/api/securing-your-api.md) and describe it as a
 * Dashboard action. Two things are unmeasured:
 *
 *   1. whether there is a PAT-usable lever at all. The published /v1 spec has
 *      no `enabled` field on PATCH /v1/projects/{ref}/postgrest - only
 *      db_schema / max_rows / db_extra_search_path / db_pool. The hypothesis
 *      under test is that an EMPTY db_schema is the API-side equivalent of the
 *      Dashboard toggle. If the PATCH is rejected, that is the finding: the
 *      posture is dashboard-only and cannot be asserted in IaC.
 *   2. whether the private data path is genuinely unaffected. "Disable the
 *      HTTP tier, keep Postgres over PrivateLink" is the whole of posture A,
 *      and it has only ever been reasoned about, never run.
 *
 * DESTRUCTIVE: mutates project configuration. Restores the baseline in a
 * finally block, and records whether the restore itself worked - a test that
 * leaves the API off is worse than a test that never ran.
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const MGMT = "https://api.supabase.com";
const POLL_MS = 5000;
const MAX_WAIT_MS = 180_000;
const PROBE_TABLE = "pvlab_probe"; // created by T08/T09; SQL-created, so anon SELECT via default privileges

interface PostgrestConfig {
  db_schema: string;
  max_rows?: number;
  db_extra_search_path?: string;
  db_pool?: number;
}

async function mgmt(ctx: Ctx, method: string, path: string, body?: unknown) {
  const res = await fetch(`${MGMT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.pat}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, text, json };
}

/** One anon-key read against a real table - the only honest liveness probe. */
async function restProbe(ctx: Ctx) {
  const key = ctx.anonKey ?? "";
  try {
    const res = await fetch(
      `https://${ctx.apiHost}/rest/v1/${PROBE_TABLE}?select=id&limit=1`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

/** Poll until the predicate holds; returns seconds elapsed, or null on timeout. */
async function waitFor(
  ctx: Ctx,
  label: string,
  pred: (r: { status: number; body: string }) => boolean,
): Promise<{ seconds: number | null; last: { status: number; body: string } }> {
  const t0 = Date.now();
  let last = await restProbe(ctx);
  while (Date.now() - t0 < MAX_WAIT_MS) {
    if (pred(last)) return { seconds: Math.round((Date.now() - t0) / 1000), last };
    ctx.log(`${label}: HTTP ${last.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
    await Bun.sleep(POLL_MS);
    last = await restProbe(ctx);
  }
  return { seconds: pred(last) ? Math.round((Date.now() - t0) / 1000) : null, last };
}

async function dbStillWorks(ctx: Ctx, port: number) {
  const client = new Client({
    host: ctx.phzHost,
    port,
    user: "postgres",
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  const t0 = performance.now();
  try {
    await client.connect();
    await client.query(`select count(*) from ${PROBE_TABLE}`);
    return { ok: true, ms: Math.round(performance.now() - t0), error: "" };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.end().catch(() => {});
  }
}

/** `db push` over the endpoint while the HTTP tier is off - posture A's ops path. */
async function pushOverEndpoint(ctx: Ctx) {
  const dir = "/tmp/pvlab-t22";
  await $`rm -rf ${dir}`.quiet().nothrow();
  await $`mkdir -p ${dir}`.quiet().nothrow();
  const init = await $`bash -lc "supabase init --force"`.cwd(dir).quiet().nothrow();
  if (init.exitCode !== 0) return { ok: false, out: "supabase init failed" };
  await Bun.write(
    `${dir}/supabase/migrations/20260802000000_pvlab.sql`,
    `create table if not exists ${PROBE_TABLE} (id int primary key, at timestamptz default now());\n`,
  );
  const url = `postgresql://postgres:${encodeURIComponent(ctx.dbPassword)}@${ctx.phzHost}:5432/postgres?sslmode=require`;
  const p = await $`bash -lc ${`printf 'y\\n' | supabase db push --db-url '${url}' --include-all`}`
    .cwd(dir)
    .env({ ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" })
    .quiet()
    .nothrow();
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  return { ok: p.exitCode === 0, out: out.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300) };
}

const mod: TestModule = {
  id: "T22",
  title: "Data API disabled: HTTP tier off, private data path intact",
  where: "runner",
  requires: ["db", "pat", "anon-key"],
  destructive: true,
  async run(ctx) {
    const results: TestResult[] = [];

    const before = await mgmt(ctx, "GET", `/v1/projects/${ctx.ref}/postgrest`);
    if (!before.ok) {
      return {
        id: "T22a",
        title: "read the PostgREST config",
        status: "fail",
        detail: `GET /v1/projects/{ref}/postgrest returned HTTP ${before.status}`,
        evidence: before.text.slice(0, 300),
      };
    }
    const baseline = before.json as PostgrestConfig;
    ctx.log(`baseline db_schema = "${baseline.db_schema}"`);

    const live = await restProbe(ctx);
    results.push({
      id: "T22a",
      title: "Data API baseline (anon read of a real table)",
      status: live.status === 200 ? "pass" : "info",
      detail:
        live.status === 200
          ? `anon SELECT on ${PROBE_TABLE} answers 200`
          : `baseline is not a clean 200 - later readings are relative to HTTP ${live.status}`,
      measurements: { status: live.status, db_schema: baseline.db_schema },
      evidence: live.body,
    });

    // The lever itself. An empty db_schema is the hypothesis; a rejection here
    // is a result, not a failure of the test.
    const off = await mgmt(ctx, "PATCH", `/v1/projects/${ctx.ref}/postgrest`, { db_schema: "" });
    results.push({
      id: "T22b",
      title: "PAT-usable lever for disabling the Data API",
      status: off.ok ? "pass" : "info",
      detail: off.ok
        ? "PATCH /v1/projects/{ref}/postgrest accepted db_schema=\"\" - the posture is expressible without the Dashboard"
        : `PATCH rejected with HTTP ${off.status} - no /v1 lever; the toggle is Dashboard-only and cannot be asserted in IaC`,
      measurements: { patch_status: off.status },
      evidence: off.text.slice(0, 300),
    });

    if (!off.ok) return results;

    try {
      const dead = await waitFor(ctx, "waiting for REST to stop answering", (r) => r.status !== 200);
      results.push({
        id: "T22c",
        title: "Data API stops answering",
        status: dead.seconds === null ? "fail" : "pass",
        detail:
          dead.seconds === null
            ? `still HTTP ${dead.last.status} after ${MAX_WAIT_MS / 1000}s - the empty schema did not take effect`
            : `REST went from 200 to HTTP ${dead.last.status} within ${dead.seconds}s`,
        measurements: {
          time_to_effect_s: dead.seconds ?? "timeout",
          disabled_status: dead.last.status,
          poll_interval_s: POLL_MS / 1000,
        },
        evidence: dead.last.body,
      });

      for (const port of [5432, 6543]) {
        const db = await dbStillWorks(ctx, port);
        results.push({
          id: port === 5432 ? "T22d" : "T22e",
          title: `private path on ${port} with the Data API off`,
          status: db.ok ? "pass" : "fail",
          detail: db.ok
            ? `query succeeded over ${ctx.phzHost}:${port} while the HTTP tier is disabled`
            : db.error,
          measurements: { connect_query_ms: db.ms },
        });
      }

      const push = await pushOverEndpoint(ctx);
      results.push({
        id: "T22f",
        title: "`db push --db-url` with the Data API off",
        status: push.ok ? "pass" : "fail",
        detail: push.ok
          ? "migrations still apply over the endpoint - ops path survives the lockdown"
          : push.out,
        evidence: push.ok ? push.out : undefined,
      });
    } finally {
      const restore = await mgmt(ctx, "PATCH", `/v1/projects/${ctx.ref}/postgrest`, {
        db_schema: baseline.db_schema,
      });
      const back = restore.ok
        ? await waitFor(ctx, "waiting for REST to come back", (r) => r.status === 200)
        : null;
      results.push({
        id: "T22g",
        title: "restore the Data API",
        status: back?.seconds != null ? "pass" : "fail",
        detail: !restore.ok
          ? `restore PATCH returned HTTP ${restore.status} - PROJECT LEFT WITH THE DATA API OFF`
          : back?.seconds != null
            ? `back to 200 within ${back.seconds}s (db_schema restored to "${baseline.db_schema}")`
            : `restore accepted but REST still HTTP ${back?.last.status} after ${MAX_WAIT_MS / 1000}s`,
        measurements: { recovery_s: back?.seconds ?? "timeout", restore_status: restore.status },
      });
    }

    return results;
  },
};
export default mod;
