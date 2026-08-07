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
 *      posture is Dashboard-only and cannot be asserted in IaC.
 *   2. whether the private data path is genuinely unaffected. "Disable the
 *      HTTP tier, keep Postgres over PrivateLink" is the whole of posture A,
 *      and it has only ever been reasoned about, never run.
 *
 * Gating: the lever question (a) needs nothing but a PAT and an anon key, so
 * it answers on any project from anywhere. The private-path rows need `db` and
 * self-skip with a reason when it is absent, rather than gating the whole
 * module behind infrastructure the question does not require.
 *
 * Liveness is measured as a CHANGE from each probe's own baseline status, not
 * against an assumed 200: on a fresh project there is no table to read, and
 * PostgREST's root answers 401 by design (T13). Two probes are recorded
 * verbatim so the disabled-state response shape is evidence, not a paraphrase.
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
/** Created by T08/T09. SQL-created, so anon SELECT via default privileges. */
const PROBE_TABLE = "pvlab_probe";

interface PostgrestConfig {
  db_schema: string;
  max_rows?: number;
  db_extra_search_path?: string;
  db_pool?: number;
}

interface Probe {
  status: number;
  body: string;
}
interface Snapshot {
  table: Probe;
  root: Probe;
  graphql: Probe;
}

/** How long to hold the disabled state before re-sampling (see T22h). */
const HOLD_MS = 30_000;

/**
 * Distinguish "deliberately disabled" from "wedged". PGRST002 is PostgREST
 * failing to build a schema cache and retrying - a degraded service, not a
 * removed surface, and indistinguishable from an outage to a caller.
 */
function classify(s: Snapshot): string {
  if (/PGRST002/.test(s.table.body)) return "wedged (PGRST002 schema-cache retry loop)";
  if (s.table.status === 503) return "503, unclassified body";
  if (s.table.status === 404 && /PGRST205/.test(s.table.body)) return "answering normally (table absent)";
  if (s.table.status === 200) return "answering normally";
  return `HTTP ${s.table.status}`;
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

async function get(ctx: Ctx, path: string): Promise<Probe> {
  const key = ctx.anonKey ?? "";
  try {
    const res = await fetch(`https://${ctx.apiHost}${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

async function snapshot(ctx: Ctx): Promise<Snapshot> {
  return {
    table: await get(ctx, `/rest/v1/${PROBE_TABLE}?select=id&limit=1`),
    root: await get(ctx, "/rest/v1/"),
    // pg_graphql rides the same PostgREST process - collateral damage belongs
    // in the evidence, not in a footnote.
    graphql: await get(ctx, "/graphql/v1"),
  };
}

const changed = (a: Snapshot, b: Snapshot) =>
  a.table.status !== b.table.status || a.root.status !== b.root.status;

/** Poll until the snapshot differs from (or returns to) the reference. */
async function waitUntil(
  ctx: Ctx,
  label: string,
  ref: Snapshot,
  want: "differs" | "matches",
): Promise<{ seconds: number | null; last: Snapshot }> {
  const t0 = Date.now();
  let last = await snapshot(ctx);
  const hit = () => (want === "differs" ? changed(ref, last) : !changed(ref, last));
  while (Date.now() - t0 < MAX_WAIT_MS) {
    if (hit()) return { seconds: Math.round((Date.now() - t0) / 1000), last };
    ctx.log(
      `${label}: table=${last.table.status} root=${last.root.status} after ${Math.round((Date.now() - t0) / 1000)}s`,
    );
    await Bun.sleep(POLL_MS);
    last = await snapshot(ctx);
  }
  return { seconds: hit() ? Math.round((Date.now() - t0) / 1000) : null, last };
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
    await client.query("select 1");
    return { ok: true, ms: Math.round(performance.now() - t0), error: "" };
  } catch (e) {
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: e instanceof Error ? e.message : String(e),
    };
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
  return {
    ok: p.exitCode === 0,
    out: out.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 300),
  };
}

const mod: TestModule = {
  id: "T22",
  title: "Data API disabled: HTTP tier off, private data path intact",
  where: "runner",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx) {
    const results: TestResult[] = [];
    const hasDb = ctx.capabilities.has("db");
    const noDb = (id: string, title: string) =>
      results.push({
        id,
        title,
        status: "skip",
        detail: "no db capability from this vantage - the lever question does not need one",
      });

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

    const live = await snapshot(ctx);

    // BASELINE GATE: the private-path claim below ("DB still works with the
    // Data API off") is meaningless if the DB path was already broken before
    // touching anything - the run would report a pre-existing failure as
    // though this test's own mutation had caused it.
    if (hasDb) {
      const baselineDb = await dbStillWorks(ctx, 5432);
      if (!baselineDb.ok) {
        return {
          id: "T22",
          title: mod.title,
          status: "skip",
          detail: `baseline private-path probe on 5432 failed before any change (${baselineDb.error}) - no control, no conclusion`,
        };
      }
    }

    results.push({
      id: "T22a",
      title: "Data API baseline (anon table read + PostgREST root)",
      status: "info",
      detail: `table probe HTTP ${live.table.status}, root HTTP ${live.root.status} - later readings are deltas from these`,
      measurements: {
        table_status: live.table.status,
        root_status: live.root.status,
        db_schema: baseline.db_schema,
      },
      evidence: `table: ${live.table.body}\nroot: ${live.root.body}`,
    });

    // The lever itself. An empty db_schema is the hypothesis; a rejection here
    // is a result, not a failure of the test.
    const off = await mgmt(ctx, "PATCH", `/v1/projects/${ctx.ref}/postgrest`, { db_schema: "" });
    results.push({
      id: "T22b",
      title: "PAT-usable lever for disabling the Data API",
      status: off.ok ? "pass" : "info",
      detail: off.ok
        ? 'PATCH /v1/projects/{ref}/postgrest accepted db_schema="" - a lever exists; whether it DISABLES the Data API or merely breaks it is T22c/T22h'
        : `PATCH rejected with HTTP ${off.status} - no /v1 lever; the toggle is Dashboard-only and cannot be asserted in IaC`,
      measurements: { patch_status: off.status },
      evidence: off.text.slice(0, 300),
    });

    if (!off.ok) return results;

    try {
      const dead = await waitUntil(ctx, "waiting for the Data API to change state", live, "differs");
      results.push({
        id: "T22c",
        title: "Data API stops answering",
        status: dead.seconds === null ? "fail" : "pass",
        detail:
          dead.seconds === null
            ? `no change after ${MAX_WAIT_MS / 1000}s - an empty db_schema is accepted but does NOT disable the Data API`
            : `table probe ${live.table.status} -> ${dead.last.table.status}, root ${live.root.status} -> ${dead.last.root.status} within ${dead.seconds}s`,
        measurements: {
          time_to_effect_s: dead.seconds ?? "no change",
          disabled_table_status: dead.last.table.status,
          disabled_root_status: dead.last.root.status,
          disabled_graphql_status: dead.last.graphql.status,
          poll_interval_s: POLL_MS / 1000,
        },
        evidence: `table: ${dead.last.table.body}\nroot: ${dead.last.root.body}\ngraphql: ${dead.last.graphql.body}`,
      });

      // A single sample cannot tell a disabled service from a restarting one.
      await Bun.sleep(HOLD_MS);
      const held = await snapshot(ctx);
      results.push({
        id: "T22h",
        title: `disabled state ${HOLD_MS / 1000}s later`,
        status: "info",
        detail: `${classify(held)}; root still HTTP ${held.root.status}, graphql HTTP ${held.graphql.status}`,
        measurements: {
          held_s: HOLD_MS / 1000,
          table_status: held.table.status,
          root_status: held.root.status,
          graphql_status: held.graphql.status,
          classification: classify(held),
        },
        evidence: `table: ${held.table.body}\ngraphql: ${held.graphql.body}`,
      });

      if (hasDb) {
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
            ? "migrations still apply over the endpoint - the ops path survives the lockdown"
            : push.out,
          evidence: push.out,
        });
      } else {
        noDb("T22d", "private path on 5432 with the Data API off");
        noDb("T22e", "private path on 6543 with the Data API off");
        noDb("T22f", "`db push --db-url` with the Data API off");
      }
    } finally {
      const restore = await mgmt(ctx, "PATCH", `/v1/projects/${ctx.ref}/postgrest`, {
        db_schema: baseline.db_schema,
      });
      const back = restore.ok ? await waitUntil(ctx, "waiting for the Data API to return", live, "matches") : null;
      results.push({
        id: "T22g",
        title: "restore the Data API",
        status: back?.seconds != null ? "pass" : "fail",
        detail: !restore.ok
          ? `restore PATCH returned HTTP ${restore.status} - PROJECT LEFT WITH THE DATA API OFF`
          : back?.seconds != null
            ? `back to the baseline response shape within ${back.seconds}s (db_schema restored to "${baseline.db_schema}")`
            : `restore accepted but the probes still differ after ${MAX_WAIT_MS / 1000}s`,
        measurements: { recovery_s: back?.seconds ?? "timeout", restore_status: restore.status },
      });
    }

    return results;
  },
};
export default mod;
