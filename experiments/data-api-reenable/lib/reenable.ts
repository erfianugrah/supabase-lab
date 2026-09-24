/**
 * Shared pieces for experiments/data-api-reenable.
 *
 * The question: after the Data API is switched back on, how long until it
 * serves, what does a client see in between, and which signal can a client
 * poll to know it is back? The Dashboard toggle writes `db_schema` on
 * `PATCH /v1/projects/{ref}/postgrest` (http-tier-lockdown run 2, and Studio's
 * DataApiEnableSwitch.tsx), so the PATCH is the same lever and is scriptable.
 *
 * The harness sampler (harness/src/sampler.ts) is not used here: it runs every
 * path at one interval and keeps only the first fail and the settled recovery.
 * This module needs a per-path interval (the Management API health endpoint
 * shares the 120/min budget, the HTTP paths do not) and the full sequence of
 * states, because "which readiness signal flips at the same moment as the
 * data path" is a question about the ORDER of transitions.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql, type ProjectKeys } from "../../../harness/src/platform.js";

export const TABLE = "da_probe";
export const RPC = "da_ping";
export const EXTRA_SCHEMA = "da_api";

export interface PostgrestConfig {
  db_schema: string;
  max_rows: number;
  db_extra_search_path: string;
  db_pool: number | null;
}

export async function getPostgrest(ctx: Ctx): Promise<PostgrestConfig> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/postgrest`);
  if (r.status !== 200) throw new Error(`GET postgrest http ${r.status}`);
  const j = r.json as Record<string, unknown>;
  // jwt_secret is in this body too; never copy it anywhere.
  return {
    db_schema: String(j.db_schema ?? ""),
    max_rows: Number(j.max_rows ?? 1000),
    db_extra_search_path: String(j.db_extra_search_path ?? ""),
    db_pool: (j.db_pool as number | null) ?? null,
  };
}

/**
 * Same body shape Studio's toggle sends: the whole config, db_schema varied.
 * `db_pool` is omitted when null - a fresh project reads `db_pool: null` and the
 * PATCH refuses to take it back (`400 "db_pool: Invalid input: expected number,
 * received null"`, 2026-09-24), which silently turned the first smoke run into
 * a no-op. Throws on non-200 so that cannot happen again.
 */
export async function setSchemas(ctx: Ctx, base: PostgrestConfig, dbSchema: string) {
  const r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/postgrest`, {
    db_schema: dbSchema,
    max_rows: base.max_rows,
    db_extra_search_path: base.db_extra_search_path,
    ...(base.db_pool !== null ? { db_pool: base.db_pool } : {}),
  });
  if (r.status !== 200) throw new Error(`PATCH postgrest db_schema="${dbSchema}" http ${r.status}: ${r.text.slice(0, 200)}`);
  return r;
}

/** Idempotent fixture: a table and an RPC anon can reach, plus an extra schema. */
export async function seedFixture(ctx: Ctx): Promise<string> {
  const steps = [
    `create table if not exists public.${TABLE} (id int primary key, note text)`,
    `insert into public.${TABLE} values (1, 'one') on conflict do nothing`,
    `grant select on public.${TABLE} to anon`,
    `create or replace function public.${RPC}() returns text language sql stable as $$ select 'pong' $$`,
    `grant execute on function public.${RPC}() to anon`,
    `create schema if not exists ${EXTRA_SCHEMA}`,
    `grant usage on schema ${EXTRA_SCHEMA} to anon`,
    `create table if not exists ${EXTRA_SCHEMA}.${TABLE} (id int primary key)`,
    `insert into ${EXTRA_SCHEMA}.${TABLE} values (1) on conflict do nothing`,
    `grant select on ${EXTRA_SCHEMA}.${TABLE} to anon`,
    `notify pgrst, 'reload schema'`,
  ];
  for (const s of steps) {
    const r = await sql(ctx, s);
    if (r.status >= 300) return `${s.slice(0, 60)}: ${r.error}`;
  }
  return "";
}

export interface Obs {
  ok: boolean;
  /** "503 PGRST002", "200", "timeout" - the state label transitions are keyed on. */
  state: string;
}

async function httpObs(
  url: string,
  init: RequestInit,
  okWhen: (status: number, body: string) => boolean,
): Promise<Obs> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    let code = "";
    try {
      const j = JSON.parse(body);
      code = String(j.code ?? j.error ?? j.message ?? "").slice(0, 40);
    } catch {
      /* non-JSON body */
    }
    const ok = okWhen(res.status, body);
    // A 200 that okWhen rejects (GraphQL's error envelope) must not read as
    // "200" in a transition list, or it looks identical to success.
    const label = code && !ok ? `${res.status} ${code}` : !ok && res.status === 200 ? "200 not-ok" : String(res.status);
    return { ok, state: label };
  } catch (e) {
    const msg = e instanceof Error ? e.name : String(e);
    return { ok: false, state: msg === "TimeoutError" ? "timeout" : msg.slice(0, 40) };
  }
}

export interface PathProbe {
  name: string;
  intervalMs: number;
  run(): Promise<Obs>;
}

/**
 * The paths an application uses and whose recovery ends a timeline. GraphQL is
 * sampled but not in here: new projects no longer have pg_graphql enabled
 * (2026-09-24: `/graphql/v1` answers 200 with "pg_graphql extension is not
 * enabled."), so it can never turn ok, and gating on it made the first smoke
 * run wait out its full 600 s budget.
 */
export const APP_PATHS = ["rest_table", "rest_rpc"];

/**
 * Every path a client or an operator could watch. The first three are what an
 * application uses; the rest are readiness CANDIDATES, and the finding is
 * which of them (if any) turns green at the same moment as the first three.
 */
export function dataApiProbes(ctx: Ctx, keys: ProjectKeys, fastMs = 250): PathProbe[] {
  const base = `https://${ctx.apiHost}`;
  const anon = { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` };
  const svc = { apikey: keys.service, Authorization: `Bearer ${keys.service}` };
  const is200 = (s: number) => s === 200;
  return [
    {
      name: "rest_table",
      intervalMs: fastMs,
      run: () => httpObs(`${base}/rest/v1/${TABLE}?select=id&limit=1`, { headers: anon }, is200),
    },
    {
      name: "rest_rpc",
      intervalMs: fastMs,
      run: () =>
        httpObs(
          `${base}/rest/v1/rpc/${RPC}`,
          { method: "POST", headers: { ...anon, "Content-Type": "application/json" }, body: "{}" },
          is200,
        ),
    },
    {
      name: "graphql",
      intervalMs: fastMs,
      run: () =>
        httpObs(
          `${base}/graphql/v1`,
          {
            method: "POST",
            headers: { ...anon, "Content-Type": "application/json" },
            body: JSON.stringify({ query: "{ __typename }" }),
          },
          (s, b) => s === 200 && !b.includes('"errors"'),
        ),
    },
    {
      // The OpenAPI root. Needs service_role on the platform (privatelink-aws
      // key facts), and is served from the schema cache.
      name: "rest_root_svc",
      intervalMs: fastMs,
      run: () => httpObs(`${base}/rest/v1/`, { headers: svc }, is200),
    },
    {
      // PostgREST's own admin readiness route. Whether the gateway exposes
      // it at all is part of the question; a steady 404 is an answer.
      name: "rest_admin_ready",
      intervalMs: fastMs,
      run: () => httpObs(`${base}/rest-admin/v1/ready`, { headers: svc }, is200),
    },
    {
      name: "mgmt_health_rest",
      intervalMs: 2000,
      run: async () => {
        const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/health?services=rest`, undefined, 10_000);
        if (r.throttled) return { ok: false, state: "throttled" };
        const row = Array.isArray(r.json) ? (r.json[0] as Record<string, unknown> | undefined) : undefined;
        if (!row) return { ok: false, state: `http ${r.status}` };
        return { ok: row.healthy === true, state: `${row.status}` };
      },
    },
  ];
}

export interface PathTimeline {
  name: string;
  /** [ms since t0, state] at every state CHANGE, starting with the first sample. */
  transitions: [number, string][];
  samples: number;
  /** First ok sample. */
  firstOkMs: number | null;
  /** Start of the final unbroken run of ok samples, if it lasted settleMs. */
  sustainedOkMs: number | null;
}

export interface TimelineOpts {
  maxWaitMs: number;
  settleMs: number;
  /** Paths whose sustained-ok ends the run early. The rest are observed only. */
  stopOn: string[];
  log?: (m: string) => void;
}

/**
 * Sample every path on its own interval from t0 until every `stopOn` path has
 * been ok for settleMs, or maxWaitMs. `operation` is awaited after t0 is taken,
 * so every time is measured from the moment the lever was pulled, not from
 * when an observer happened to start (the http-tier-lockdown run 2 lesson).
 */
export async function timeline(
  probes: PathProbe[],
  opts: TimelineOpts,
  operation: () => Promise<void>,
): Promise<{ t0: number; paths: PathTimeline[] }> {
  const t0 = Date.now();
  const st = probes.map((p) => ({
    p,
    tl: { name: p.name, transitions: [], samples: 0, firstOkMs: null, sustainedOkMs: null } as PathTimeline,
    runStart: null as number | null,
  }));
  let stop = false;
  // An empty stopOn means "observe for maxWaitMs". Without the length check,
  // every() over nothing is true and the first smoke run's off-phase ended the
  // instant the PATCH returned, collapsing a 30 s hold to ~7 s.
  const done = () =>
    opts.stopOn.length > 0 &&
    st.filter((s) => opts.stopOn.includes(s.p.name)).every((s) => s.tl.sustainedOkMs !== null);

  const loops = st.map(async (s) => {
    while (!stop && Date.now() - t0 < opts.maxWaitMs) {
      // Stamped at RESPONSE time. A request sent while PostgREST restarts is
      // held by the gateway and answered 200 by the new process ~1 s later;
      // stamping at send time recorded that as "ok at +1 ms" (smoke run 3).
      const o = await s.p.run();
      const at = Date.now() - t0;
      s.tl.samples += 1;
      const last = s.tl.transitions.at(-1);
      if (!last || last[1] !== o.state) {
        s.tl.transitions.push([at, o.state]);
        opts.log?.(`${s.p.name} +${at}ms ${o.state}`);
      }
      if (o.ok) {
        if (s.tl.firstOkMs === null) s.tl.firstOkMs = at;
        if (s.runStart === null) s.runStart = at;
        if (s.tl.sustainedOkMs === null && at - s.runStart >= opts.settleMs) s.tl.sustainedOkMs = s.runStart;
      } else {
        s.runStart = null;
        // A relapse after "sustained" would make the number a lie; keep it
        // visible rather than silently keeping the earlier value.
        if (s.tl.sustainedOkMs !== null) s.tl.sustainedOkMs = null;
      }
      await Bun.sleep(s.p.intervalMs);
    }
  });

  await operation();
  while (!stop && Date.now() - t0 < opts.maxWaitMs) {
    if (done()) break;
    await Bun.sleep(100);
  }
  stop = true;
  await Promise.all(loops);
  return { t0, paths: st.map((s) => s.tl) };
}

/** "0:503 PGRST002 > 1830:200" - compact enough for one evidence line per path. */
export function fmtTransitions(tl: PathTimeline): string {
  return `${tl.name}: ` + tl.transitions.map(([t, s]) => `${t}:${s}`).join(" > ");
}

/** One status snapshot of every path, for "what does each signal say while off". */
export async function snapshot(probes: PathProbe[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    probes.map(async (p) => {
      out[p.name] = (await p.run()).state;
    }),
  );
  return out;
}
