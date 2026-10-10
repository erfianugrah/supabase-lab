/**
 * OR08 - `ALTER TABLE ... SET ACCESS METHOD orioledb` on an existing heap
 * table, and what the server does next.
 *
 * Found while probing OR06: the statement is the only documented-by-Postgres
 * way to move one table from heap to OrioleDB ("per-table USING heap / USING
 * orioledb" is a create-time choice in the announcement; conversion is not
 * mentioned there). Two throwaway OrioleDB projects, one per shape, so that a
 * server that does not come back leaves nothing else in the run affected:
 *
 *   OR08a  (`conva`) an empty heap table with a primary key, no other
 *          objects. Run the ALTER; record whether the connection survives.
 *   OR08b  (`convb`) a heap table with a foreign key to an OrioleDB table,
 *          the ALTER, then one INSERT.
 *
 * After the statement(s): reconnect every 10 s for up to OR_CONV_WAIT_S seconds
 * (default 240), read `GET /v1/projects/{ref}/health?services=db`, the project
 * `status`, and (when the platform logs answer) the Postgres log lines that
 * mention a signal, recovery or a PANIC. The last stage, "restart", calls
 * `POST /v1/projects/{ref}/restart` on a project that is still not accepting
 * connections and records the outcome after OR_CONV_WAIT_S more seconds.
 *
 * DESTRUCTIVE by design: the two projects may end unusable and are deleted
 * with the rest of the run. Result id carries the facts, there is no pass
 * condition: `info` records what happened.
 *
 * Not settled: whether the crash depends on table size, on a prior checkpoint
 * or on the compute size; whether a rebuilt project from a backup would load
 * (no restore was attempted).
 */
import type { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { logsQuery } from "../../../harness/src/platform";
import { connect, ensureExtra, skipWithoutOrg, sleep, withConn, type Proj } from "../lib/pair";

const ID = "OR08";

async function dbHealth(ctx: Ctx, ref: string): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/health?services=db`);
  const row = Array.isArray(r.json) ? (r.json as Array<{ status?: string; healthy?: boolean }>)[0] : undefined;
  return `${row?.status ?? `HTTP ${r.status}`}`;
}

async function tryConnect(p: Proj): Promise<Client | undefined> {
  try {
    return await connect(p);
  } catch {
    return undefined;
  }
}

async function step(c: Client, sql: string): Promise<string> {
  try {
    await c.query(sql);
    return "ok";
  } catch (e) {
    return (e as Error).message.replace(/\s+/g, " ").slice(0, 200);
  }
}

async function aftermath(ctx: Ctx, p: Proj, waitS: number): Promise<Record<string, string | number>> {
  const m: Record<string, string | number> = {};
  const t0 = Date.now();
  let back = -1;
  while ((Date.now() - t0) / 1000 < waitS) {
    const c = await tryConnect(p);
    if (c) {
      back = Math.round((Date.now() - t0) / 1000);
      const r = await step(c, "select count(*) from public.conv_t");
      m.select_after_recovery = r;
      await c.end().catch(() => undefined);
      break;
    }
    await sleep(10_000);
  }
  m.reconnect_after_s = back;
  m.db_health_after = await dbHealth(ctx, p.ref);
  const pr = await mgmt(ctx, "GET", `/projects/${p.ref}`);
  m.project_status_after = String((pr.json as { status?: string } | undefined)?.status ?? `HTTP ${pr.status}`);
  const lg = await logsQuery(
    { ...ctx, ref: p.ref },
    "select timestamp, event_message from logs where source = 'postgres_logs' and (event_message like '%signal%' or event_message like '%recovery workers%' or event_message like '%PANIC%' or event_message like '%TRAP%' or event_message like '%startup process%') order by timestamp asc limit 200",
    1,
  );
  if (lg.error) m.log_query = lg.error;
  else {
    m.log_signal_lines = lg.rows.length;
    m.log_first_line = String(lg.rows[0]?.event_message ?? "").slice(0, 160);
    m.log_distinct_messages = [...new Set(lg.rows.map((r) => String(r.event_message ?? "").replace(/PID \d+/, "PID n")))].slice(0, 6).join(" | ").slice(0, 500);
  }
  return m;
}

const mod: TestModule = {
  id: ID,
  title: "ALTER TABLE SET ACCESS METHOD orioledb on a heap table: backend and recovery behaviour",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title, ["conva", "convb"]);
    if (skipped) return skipped;
    const out: TestResult[] = [];
    const waitS = Number(process.env.OR_CONV_WAIT_S ?? "240");
    const [a, b] = await Promise.all([ensureExtra(ctx, "conva"), ensureExtra(ctx, "convb")]);

    // Set up both, then run the two conversions at the same time.
    await withConn(a, async (c) => {
      await c.query("drop table if exists public.conv_t");
      await c.query("create table public.conv_t (id bigint primary key, v text) using heap");
    });
    await withConn(b, async (c) => {
      await c.query("drop table if exists public.conv_c, public.conv_t cascade");
      await c.query("create table public.conv_t (id bigint primary key) using orioledb");
      await c.query("create table public.conv_c (id bigint primary key, p bigint references public.conv_t(id)) using heap");
    });

    const ra: Record<string, string | number> = {};
    const ca = await connect(a);
    ra.alter = await step(ca, "alter table public.conv_t set access method orioledb");
    ra.amname_after = ra.alter === "ok" ? await step(ca, "select 1 from pg_class c join pg_am m on m.oid = c.relam where c.relname = 'conv_t' and m.amname = 'orioledb'") : "(not read)";
    if (ra.alter === "ok") ra.insert_after = await step(ca, "insert into public.conv_t values (1, 'x')");
    await ca.end().catch(() => undefined);
    Object.assign(ra, await aftermath(ctx, a, waitS));
    out.push({
      id: `${ID}a`,
      title: "OR08a: empty heap table, primary key only, converted to OrioleDB",
      status: "info",
      detail: `ALTER: ${ra.alter}; reconnect after ${ra.reconnect_after_s} s; db health ${ra.db_health_after}`,
      measurements: ra,
    });

    const rb: Record<string, string | number> = {};
    const cb = await connect(b);
    rb.alter = await step(cb, "alter table public.conv_c set access method orioledb");
    if (rb.alter === "ok") rb.insert_after = await step(cb, "insert into public.conv_c values (1, null)");
    await cb.end().catch(() => undefined);
    Object.assign(rb, await aftermath(ctx, b, waitS));
    out.push({
      id: `${ID}b`,
      title: "OR08b: heap table with a foreign key to an OrioleDB table, converted, then one INSERT",
      status: "info",
      detail: `ALTER: ${rb.alter}; INSERT: ${rb.insert_after ?? "(not run)"}; reconnect after ${rb.reconnect_after_s} s; db health ${rb.db_health_after}`,
      measurements: rb,
    });

    // Restart whichever project is still down, once.
    for (const [label, p, res] of [["a", a, ra], ["b", b, rb]] as const) {
      if (Number(res.reconnect_after_s) >= 0) continue;
      const r = await mgmt(ctx, "POST", `/projects/${p.ref}/restart`);
      const t0 = Date.now();
      let back = -1;
      while ((Date.now() - t0) / 1000 < waitS) {
        await sleep(15_000);
        const c = await tryConnect(p);
        if (c) {
          back = Math.round((Date.now() - t0) / 1000);
          await c.end().catch(() => undefined);
          break;
        }
      }
      out.push({
        id: `${ID}${label}-restart`,
        title: `OR08${label}-restart: POST /restart on the project that did not come back`,
        status: "info",
        detail: `restart HTTP ${r.status}; reconnect after ${back} s (-1 = never within ${waitS} s); db health ${await dbHealth(ctx, p.ref)}`,
        measurements: { restart_status: r.status, reconnect_after_restart_s: back, waited_s: waitS, db_health_after: await dbHealth(ctx, p.ref) },
      });
    }
    return out;
  },
};

export default mod;
