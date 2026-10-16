/**
 * TD01 - database per tenant: create-to-first-query, burst, delete on Turso,
 * D1 and Postgres schemas
 *
 * Question: what does it cost, in time and in refusals, to give each tenant
 * (or agent) its own database? One tenant is created alone, then a burst of
 * TD01_BURST (default 20; 2 under TD_SMOKE=1) is created in parallel, then
 * every tenant is deleted, per backend:
 *
 *   turso      Turso Platform API `POST /databases` in the fixture's group
 *              (sec-syd, aws-ap-southeast-2), then a per-database token
 *              (`POST /databases/{db}/auth/tokens`), then the first query over
 *              Hrana HTTP (@libsql/client/web) from this machine.
 *   d1         Cloudflare `POST /d1/database` (location hint oc), first query
 *              through the D1 REST query endpoint: the ADMIN path. A Worker
 *              binding to a new database needs a redeploy, so the app-path
 *              first query is not what this measures.
 *   pg_schema  `CREATE SCHEMA` on the fixture project (Micro, ap-southeast-2)
 *              over the transaction pooler (6543), one connection per tenant
 *              opened before the clock starts (connect time recorded apart).
 *
 * "First query" is the same three statements everywhere: create the tenant's
 * table, upsert one row, read it back (retried until it succeeds or 180 s;
 * attempts and the first error text are recorded, since a fresh database
 * that is not yet reachable is part of the answer). create_to_first_query_ms
 * runs from the create call's start to the successful read-back, and for
 * Turso includes the token mint. burst_wall_ms is the whole parallel burst
 * (for pg_schema it includes opening the per-tenant connections, which
 * create_to_first_query_ms does not).
 *
 *   TD01a  turso single     n=1: create_ms, token_ms, first_query_ms, create_to_first_query_ms, attempts, delete_ms
 *   TD01b  d1 single        n=1: same, plus created_in_region and served_by_region from the query meta
 *   TD01c  pg_schema single n=1: same, plus connect_ms
 *   TD01d  turso burst      n=TD01_BURST in parallel: created/ready/refused counts, p50/p95/max, verbatim refusal text, parallel delete p50/p95/max
 *   TD01i/j  tursodb single / burst: the TD01a/d path with use_tursodb: true (only when the fixture has a Turso-engine database;
 *            the 2026-10-16 run wrote them as TD01g/TD01h, TD01g colliding with the Supabase project row)
 *   TD01e  d1 burst         same
 *   TD01f  pg_schema burst  same
 *   TD01g  Supabase project create for scale: the fixture's own `make up`
 *          numbers (n=1, ACTIVE_HEALTHY and every readiness check), not a
 *          second project
 *   TD01z  cleanup: every sec-td01-<stamp>- database / schema listed after the deletes
 *
 * Order: singles then bursts, the backend order rotating between the two
 * phases (lib/stats roundRobin) so neither phase always starts on the same
 * vendor. Every row records backend, vantage (local), path, location or
 * served_by_region, and n. A plan-ceiling refusal in a burst is a result
 * (status info, verbatim text in `errors`), not a crash.
 *
 * Not settled by this module: Worker-vantage first queries (needs a binding
 * per tenant and a redeploy), the plan ceilings themselves beyond the burst
 * size (100 Turso databases on Free, 50,000 D1 databases on Paid are docs
 * figures, not reached), per-tenant cost, connection-count behaviour of many
 * schemas under load, Turso's group-scoped token as an alternative to one
 * token per database, and project-per-tenant on Supabase beyond the fixture's
 * one create.
 *
 * DESTRUCTIVE: creates 1 + TD01_BURST Turso databases, D1 databases and
 * Postgres schemas, all named sec-td01-<stamp>-*; every one is deleted in the
 * run, and finally lists each vendor by the run's prefix and deletes what is
 * left. Self-skips without the fixture, the Cloudflare trio or the Turso
 * token/org.
 */
import { createClient } from "@libsql/client/web";
import pg from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Fixture, fixtureOrSkip, pgConfig } from "../lib/client";
import { D1_LOCATION_HINT } from "../lib/contract";
import { literalsOf } from "../lib/fixture";
import { roundRobin } from "../lib/stats";
import {
  burstColumns,
  burstSize,
  deleteColumns,
  firstQuerySql,
  pgIdent,
  r2,
  redact,
  type TenantOutcome,
  tenantNames,
  untilOk,
} from "../lib/td01-tenants";
import { assertSec, type CfCreds, cf, cfCreds, cfErr, createD1, createTursoDb, d1Rest, deleteD1, deleteTursoDb, listD1, listTurso, type TursoCreds, tursoCreds, tursoDbToken } from "../lib/vendors";

const ID = "TD01";
const FIRST_QUERY_DEADLINE_MS = 180_000;

type Key = "turso" | "tursodb" | "d1" | "pg_schema";

interface Outcome extends TenantOutcome {
  connectMs?: number;
  facts?: Record<string, string>;
}

interface Tenants {
  key: Key;
  path: string;
  location: string;
  /** Onboard one tenant. Never throws: failures land in the outcome. */
  onboard(name: string): Promise<Outcome>;
  /** Timed delete of one tenant this run created; returns ms, throws on failure. */
  remove(name: string): Promise<number>;
  /** Names still present under the run prefix. */
  leftovers(runPrefix: string): Promise<string[]>;
  /** Safety-net delete by name (prefix-checked). */
  sweep(name: string): Promise<void>;
  close(): Promise<void>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => performance.now();

function tursoTenants(tc: TursoCreds, group: string, location: string, red: (s: string) => string, engine: "libsql" | "tursodb" = "libsql"): Tenants {
  return {
    key: engine === "tursodb" ? "tursodb" : "turso",
    path: `Platform API create${engine === "tursodb" ? " (use_tursodb: true)" : ""} + per-db token + Hrana HTTP (@libsql/client/web)`,
    location,
    async onboard(name) {
      const t0 = now();
      let hostname: string;
      try {
        hostname = (await createTursoDb(tc, name, group, engine === "tursodb")).hostname;
      } catch (e) {
        return { name, created: false, ready: false, error: red(msg(e)) };
      }
      const createMs = r2(now() - t0);
      const tk = await untilOk(() => tursoDbToken(tc, name, "1d"), { deadlineMs: 60_000 });
      const tokenMs = r2(tk.lastMs);
      if (!tk.ok) return { name, created: true, createMs, ready: false, error: `token: ${red(tk.lastError ?? "")}` };
      const q = firstQuerySql("sqlite");
      const client = createClient({ url: `https://${hostname}`, authToken: tk.value!, intMode: "number" });
      try {
        const fq = await untilOk(
          async () => {
            await client.execute(q.create);
            await client.execute(q.insert);
            const r = await client.execute(q.select);
            if (r.rows[0]?.[0] !== "tenant") throw new Error(`read-back mismatch: ${JSON.stringify(r.rows[0] ?? null)}`);
          },
          { deadlineMs: FIRST_QUERY_DEADLINE_MS },
        );
        return {
          name,
          created: true,
          createMs,
          tokenMs,
          ready: fq.ok,
          attempts: fq.attempts,
          ...(fq.ok ? { firstQueryMs: r2(fq.lastMs), createToFirstQueryMs: r2(now() - t0) } : {}),
          ...(fq.firstError ? { error: red(fq.ok ? `before ready: ${fq.firstError}` : fq.lastError ?? "") } : {}),
        };
      } finally {
        client.close();
      }
    },
    async remove(name) {
      const t0 = now();
      const status = await deleteTursoDb(tc, name);
      const ms = r2(now() - t0);
      if (status < 200 || status >= 300) throw new Error(`delete HTTP ${status}`);
      return ms;
    },
    async leftovers(runPrefix) {
      return (await listTurso(tc)).databases.map((d) => d.name).filter((n) => n.startsWith(runPrefix));
    },
    async sweep(name) {
      await deleteTursoDb(tc, name);
    },
    async close() {},
  };
}

function d1Tenants(c: CfCreds, red: (s: string) => string): Tenants {
  const ids = new Map<string, string>();
  return {
    key: "d1",
    path: "REST create + REST /query (admin path)",
    location: `hint ${D1_LOCATION_HINT}`,
    async onboard(name) {
      const t0 = now();
      let id: string;
      const facts: Record<string, string> = {};
      try {
        const r = await createD1(c, name, D1_LOCATION_HINT);
        id = r.id;
        facts.created_in_region = String(r.raw.created_in_region ?? "");
      } catch (e) {
        return { name, created: false, ready: false, error: red(msg(e)) };
      }
      ids.set(name, id);
      const createMs = r2(now() - t0);
      const q = firstQuerySql("sqlite");
      const run = async (sql: string) => {
        const r = await d1Rest(c, id, sql);
        if (!r.success) throw new Error(cfErr(r));
        return r.result?.[0];
      };
      const fq = await untilOk(
        async () => {
          await run(q.create);
          await run(q.insert);
          const r = await run(q.select);
          const v = (r?.results?.[0] as { v?: unknown } | undefined)?.v;
          if (v !== "tenant") throw new Error(`read-back mismatch: ${JSON.stringify(r?.results?.[0] ?? null)}`);
          return r?.meta ?? {};
        },
        { deadlineMs: FIRST_QUERY_DEADLINE_MS },
      );
      if (fq.ok) {
        facts.served_by_region = String(fq.value?.served_by_region ?? "");
        facts.served_by_primary = String(fq.value?.served_by_primary ?? "");
      }
      return {
        name,
        created: true,
        createMs,
        ready: fq.ok,
        attempts: fq.attempts,
        facts,
        ...(fq.ok ? { firstQueryMs: r2(fq.lastMs), createToFirstQueryMs: r2(now() - t0) } : {}),
        ...(fq.firstError ? { error: red(fq.ok ? `before ready: ${fq.firstError}` : fq.lastError ?? "") } : {}),
      };
    },
    async remove(name) {
      const id = ids.get(name);
      if (!id) throw new Error("no id recorded");
      // Safety read (untimed): the database behind this id must carry a sec- name.
      const g = await cf<{ name?: string }>(c, "GET", `d1/database/${id}`);
      if (!g.success) throw new Error(`read before delete: ${cfErr(g)}`);
      assertSec(g.result?.name);
      if (g.result?.name !== name) throw new Error("id/name mismatch before delete");
      const t0 = now();
      const d = await cf(c, "DELETE", `d1/database/${id}`);
      const ms = r2(now() - t0);
      if (!d.success) throw new Error(`delete: ${cfErr(d)}`);
      ids.delete(name);
      return ms;
    },
    async leftovers(runPrefix) {
      return (await listD1(c)).filter((d) => d.name.startsWith(runPrefix)).map((d) => {
        ids.set(d.name, d.id);
        return d.name;
      });
    },
    async sweep(name) {
      const id = ids.get(name);
      if (id) await deleteD1(c, id);
    },
    async close() {},
  };
}

function pgTenants(fx: Fixture, red: (s: string) => string): Tenants {
  const clients = new Map<string, pg.Client>();
  let admin: pg.Client | undefined;
  const open = async () => {
    const cl = new pg.Client(await pgConfig(fx, "pooler"));
    cl.on("error", () => undefined);
    await cl.connect();
    return cl;
  };
  const adminClient = async () => (admin ??= await open());
  return {
    key: "pg_schema",
    path: "CREATE SCHEMA over the transaction pooler (6543), node-postgres",
    location: fx.supabase?.region ?? "",
    async onboard(name) {
      assertSec(name);
      let cl: pg.Client;
      const c0 = now();
      try {
        cl = await open();
      } catch (e) {
        return { name, created: false, ready: false, error: `connect: ${red(msg(e))}` };
      }
      const connectMs = r2(now() - c0);
      clients.set(name, cl);
      const t0 = now();
      try {
        await cl.query(`CREATE SCHEMA ${pgIdent(name)}`);
      } catch (e) {
        return { name, created: false, ready: false, connectMs, error: red(msg(e)) };
      }
      const createMs = r2(now() - t0);
      const q = firstQuerySql("pg", name);
      const fq = await untilOk(
        async () => {
          await cl.query(q.create);
          await cl.query(q.insert);
          const r = await cl.query(q.select);
          if (r.rows[0]?.v !== "tenant") throw new Error(`read-back mismatch: ${JSON.stringify(r.rows[0] ?? null)}`);
        },
        { deadlineMs: FIRST_QUERY_DEADLINE_MS },
      );
      return {
        name,
        created: true,
        createMs,
        connectMs,
        ready: fq.ok,
        attempts: fq.attempts,
        ...(fq.ok ? { firstQueryMs: r2(fq.lastMs), createToFirstQueryMs: r2(now() - t0) } : {}),
        ...(fq.firstError ? { error: red(fq.ok ? `before ready: ${fq.firstError}` : fq.lastError ?? "") } : {}),
      };
    },
    async remove(name) {
      const cl = clients.get(name) ?? (await adminClient());
      const t0 = now();
      await cl.query(`DROP SCHEMA ${pgIdent(name)} CASCADE`);
      const ms = r2(now() - t0);
      if (cl !== admin) {
        clients.delete(name);
        await cl.end().catch(() => undefined);
      }
      return ms;
    },
    async leftovers(runPrefix) {
      const r = await (await adminClient()).query("select nspname from pg_namespace where starts_with(nspname, $1) order by 1", [runPrefix]);
      return r.rows.map((x: { nspname: string }) => x.nspname);
    },
    async sweep(name) {
      await (await adminClient()).query(`DROP SCHEMA IF EXISTS ${pgIdent(assertSec(name))} CASCADE`);
    },
    async close() {
      for (const cl of clients.values()) await cl.end().catch(() => undefined);
      clients.clear();
      await admin?.end().catch(() => undefined);
      admin = undefined;
    },
  };
}

/** Measurement cells: drop undefined, keep numbers and strings. */
function cells(x: Record<string, number | string | undefined>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(x)) if (v !== undefined) out[k] = v;
  return out;
}

const mod: TestModule = {
  id: ID,
  title: "database per tenant: create-to-first-query, burst, delete on Turso, D1 and Postgres schemas",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = (detail: string): TestResult[] => [{ id: ID, title: this.title, status: "skip", detail }];
    const fx = await fixtureOrSkip(ctx);
    if ("skip" in fx) return skip(fx.skip);
    const c = cfCreds();
    if (!c) return skip("CLOUDFLARE_EMAIL/CLOUDFLARE_API_KEY/CLOUDFLARE_ACCOUNT_ID not set (Global API Key trio)");
    const tc = tursoCreds();
    if (!tc) return skip("TURSO_API_TOKEN and PVLAB_TURSO_ORG (or PVLAB_ORG_TURSO) not set");
    if (!fx.turso?.group) return skip("fixture has no Turso group");

    const literals = literalsOf(fx);
    const red = (s: string) => redact(s, literals);
    const burst = burstSize();
    const stamp = Date.now().toString(36);
    const names = tenantNames(stamp, burst);
    // Turso-engine tenants (when the org allows use_tursodb) get their own run prefix so the libSQL leftovers check does not see them.
    const namesM = tenantNames(`${stamp}m`, burst);
    const namesFor = (k: Key) => (k === "tursodb" ? namesM : names);
    const backends: Tenants[] = [
      tursoTenants(tc, fx.turso.group, fx.turso.location, red),
      ...(fx.tursodb?.url ? [tursoTenants(tc, fx.turso.group, fx.turso.location, red, "tursodb")] : []),
      d1Tenants(c, red),
      pgTenants(fx, red),
    ];
    const byKey = new Map(backends.map((b) => [b.key, b]));
    const order = roundRobin(backends.map((b) => b.key), 2);
    const singles = order.filter((s) => s.iter === 0).map((s) => s.item);
    const bursts = order.filter((s) => s.iter === 1).map((s) => s.item);
    const rowId: Record<Key, [string, string]> = { turso: ["TD01a", "TD01d"], d1: ["TD01b", "TD01e"], pg_schema: ["TD01c", "TD01f"], tursodb: ["TD01i", "TD01j"] };
    const base = (b: Tenants) => ({ backend: b.key, vantage: "local", colo: "local", path: b.path, location: b.location });
    const results: TestResult[] = [];
    ctx.log(`TD01: burst=${burst}, singles ${singles.join(",")}, bursts ${bursts.join(",")}`);

    try {
      /* ------------------------------ singles ------------------------------ */
      for (const key of singles) {
        const b = byKey.get(key)!;
        const id = rowId[key][0];
        const title = `${key}: one tenant, create to first query, then delete`;
        try {
          const o = await b.onboard(namesFor(key).single);
          let deleteMs: number | undefined;
          let deleteErr: string | undefined;
          if (o.created) {
            try {
              deleteMs = await b.remove(namesFor(key).single);
            } catch (e) {
              deleteErr = red(msg(e));
            }
          }
          results.push({
            id,
            title,
            status: o.ready && deleteMs !== undefined ? "pass" : o.created ? "fail" : "info",
            detail: o.ready
              ? `created in ${o.createMs} ms, first read-back at ${o.createToFirstQueryMs} ms after ${o.attempts} attempt(s); deleted in ${deleteMs ?? "-"} ms${deleteErr ? ` (delete failed: ${deleteErr})` : ""}`
              : `not ready: ${o.error ?? "unknown"}`,
            measurements: cells({
              ...base(b),
              n: 1,
              connect_ms: o.connectMs,
              create_ms: o.createMs,
              token_ms: o.tokenMs,
              first_query_ms: o.firstQueryMs,
              create_to_first_query_ms: o.createToFirstQueryMs,
              first_query_attempts: o.attempts,
              ...o.facts,
              error: o.error,
              delete_ms: deleteMs,
              delete_error: deleteErr,
            }),
          });
        } catch (e) {
          results.push({ id, title, status: "fail", detail: `threw: ${red(msg(e))}`, measurements: cells({ ...base(b), n: 1 }) });
        }
      }

      /* ------------------------------- bursts ------------------------------ */
      for (const key of bursts) {
        const b = byKey.get(key)!;
        const id = rowId[key][1];
        const title = `${key}: burst of ${burst} tenants in parallel, create to first query, then parallel delete`;
        try {
          const t0 = now();
          const outs = await Promise.all(namesFor(key).burst.map((n) => b.onboard(n)));
          const wallMs = r2(now() - t0);
          const created = outs.filter((o) => o.created).map((o) => o.name);
          const dels = await Promise.all(
            created.map((n) =>
              b.remove(n).then(
                (ms) => ({ ms }),
                (e) => ({ err: red(msg(e)) }),
              ),
            ),
          );
          const delMs = dels.flatMap((d) => ("ms" in d ? [d.ms] : []));
          const delErrs = dels.flatMap((d) => ("err" in d ? [d.err] : []));
          const cols = burstColumns(outs);
          const regions = [...new Set(outs.map((o) => o.facts?.served_by_region).filter(Boolean))].join(",");
          const createdIn = [...new Set(outs.map((o) => o.facts?.created_in_region).filter(Boolean))].join(",");
          const connect = outs.map((o) => o.connectMs).filter((x): x is number => x !== undefined);
          const allReady = cols.n_ready === burst;
          // The single-tenant delete lives on the single row.
          const { delete_single_ms: _single, ...delCols } = deleteColumns(undefined, delMs, delErrs.length);
          results.push({
            id,
            title,
            status: allReady && delErrs.length === 0 ? "pass" : cols.n_refused ? "info" : "fail",
            detail: `${cols.n_created}/${burst} created, ${cols.n_ready} ready; create p50 ${cols.create_ms_p50} ms, create-to-first-query p50 ${cols.create_to_first_query_ms_p50} ms (max ${cols.create_to_first_query_ms_max}); burst wall ${wallMs} ms; ${delMs.length} deleted${delErrs.length ? `, ${delErrs.length} delete failures` : ""}${cols.errors ? `; errors: ${cols.errors}` : ""}`,
            measurements: cells({
              ...base(b),
              n: burst,
              ...cols,
              burst_wall_ms: wallMs,
              ...(connect.length ? { connect_ms_max: r2(Math.max(...connect)) } : {}),
              ...(regions ? { served_by_region: regions } : {}),
              ...(createdIn ? { created_in_region: createdIn } : {}),
              ...delCols,
              ...(delErrs.length ? { delete_errors: [...new Set(delErrs)].join(" | ").slice(0, 300) } : {}),
            }),
          });
        } catch (e) {
          results.push({ id, title, status: "fail", detail: `threw: ${red(msg(e))}`, measurements: cells({ ...base(b), n: burst }) });
        }
      }

      /* -------------------- project-create reference (fixture) ------------------- */
      const s = fx.supabase;
      results.push({
        id: "TD01g",
        title: "Supabase project per tenant, for scale: the fixture's own project create (make up)",
        status: s?.readyMs !== undefined ? "info" : "skip",
        detail:
          s?.readyMs !== undefined
            ? `one Micro project (${s.region}) reached ACTIVE_HEALTHY at ${s.healthyMs} ms and passed every readiness check at ${s.readyMs} ms (fixture up, not re-measured here)`
            : "fixture carries no project timings",
        measurements: cells({
          backend: "supabase_project",
          vantage: "local",
          path: "Management API POST /v1/projects (fixture up)",
          location: s?.region,
          n: 1,
          healthy_ms: s?.healthyMs,
          ready_ms: s?.readyMs,
          ...Object.fromEntries(Object.entries(s?.readiness ?? {}).map(([k, v]) => [`readiness_${k}`, red(v)])),
        }),
      });
    } finally {
      /* ------------------------------- cleanup ------------------------------ */
      const left: Record<string, number | string> = {};
      const notes: string[] = [];
      let remaining = 0;
      for (const b of backends) {
        try {
          let names0 = await b.leftovers(namesFor(b.key).runPrefix);
          for (const n of names0) await b.sweep(n).catch((e) => notes.push(`${b.key} ${n}: ${red(msg(e))}`));
          if (names0.length) names0 = await b.leftovers(namesFor(b.key).runPrefix);
          left[`${b.key}_left`] = names0.length;
          remaining += names0.length;
        } catch (e) {
          left[`${b.key}_left`] = "unknown";
          remaining++;
          notes.push(`${b.key} list: ${red(msg(e))}`);
        }
        await b.close().catch(() => undefined);
      }
      results.push({
        id: "TD01z",
        title: "cleanup: nothing under the run's sec-td01- prefix left on any backend",
        status: remaining === 0 ? "pass" : "fail",
        detail: remaining === 0 ? `0 left on ${backends.map((b) => b.key).join(", ")} (prefix ${names.runPrefix})` : `left: ${JSON.stringify(left)}${notes.length ? `; ${notes.join("; ").slice(0, 300)}` : ""}`,
        measurements: { ...left, n_expected_deleted: backends.length * (1 + burst) },
      });
    }
    return results;
  },
};
export default mod;
