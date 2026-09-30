/**
 * MS04 - do role-level timeouts protect a shared project from a leaked
 * serverless connection, through transaction pooling?
 *
 * The question: a serverless function opens a transaction through the
 * pooler and dies. Does `idle_in_transaction_session_timeout`, set on the
 * app's ROLE (a session-level SET does not survive transaction pooling), free
 * the backend, and how fast? edge-resilience W20 measured `statement_timeout`
 * through the shared pooler; nothing measured the idle-in-transaction case or
 * the dedicated PgBouncer. Rows, app role `ms_app` created with the timeouts
 * and `ms_app_nolimit` without, both NOBYPASSRLS:
 *
 *   MS04a  the role GUC is what a pooled connection sees: `show
 *          idle_in_transaction_session_timeout` on dedicated 6543 (as ms_app)
 *          and on shared 6543 (as ms_app.<ref>).
 *   MS04b  statement_timeout '3s' vs pg_sleep(10) on dedicated 6543: SQLSTATE
 *          and wall time.
 *   MS04c  the leaked connection: BEGIN, read pg_backend_pid, destroy the TCP
 *          socket without COMMIT, then watch pg_stat_activity through the
 *          query endpoint until the pid is gone. Dedicated 6543 and shared
 *          6543.
 *   MS04d  the control: the same leak on ms_app_nolimit - how long the backend
 *          stays `idle in transaction` with no timeout (bounded at 60 s, then
 *          terminated by cleanup).
 *
 * DESTRUCTIVE: creates two roles, terminates their backends and drops them in
 * `finally`. Not settled: what the pooler itself does with the client-side
 * half of a dead socket (PgBouncer's client_idle_timeout), which needs a
 * longer hold than a probe run.
 */
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dedicatedTarget, errText, pgClient, primaryPooler, sharedTargets, sleep, type PgTarget } from "../lib/setup";

const IDLE_TIMEOUT = "5s";
const STMT_TIMEOUT = "3s";
const LEAK_MAX_MS = 60_000;

async function leak(ctx: Ctx, target: PgTarget, user: string, password: string): Promise<{ pid: number | null; goneS: number | string; states: string; error?: string }> {
  const c = pgClient(target, password, 10_000, user);
  // Destroying the socket makes `pg` emit 'error' ("Connection terminated
  // unexpectedly"); unhandled, that event kills the whole runner process.
  c.on("error", () => {});
  let pid: number | null = null;
  try {
    await c.connect();
    await c.query("begin");
    const r = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
    pid = Number(r.rows[0]?.pid);
    await c.query("select 1"); // the transaction is open and idle after this
  } catch (e) {
    await c.end().catch(() => {});
    return { pid, goneS: "n/a", states: "", error: errText(e) };
  }
  // Kill the socket without COMMIT or a clean Terminate message.
  const stream = (c as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream;
  const t0 = Date.now();
  stream?.destroy?.();
  const seen: string[] = [];
  let gone: number | null = null;
  while (Date.now() - t0 < LEAK_MAX_MS) {
    const q = await sql(ctx, `select state, wait_event_type, backend_type, extract(epoch from now()-state_change)::int as in_state_s from pg_stat_activity where pid = ${pid}`);
    const row = q.rows[0];
    if (!row) {
      gone = Date.now() - t0;
      break;
    }
    const st = `${row.state}`;
    if (seen[seen.length - 1] !== st) seen.push(st);
    await sleep(1000);
  }
  return { pid, goneS: gone === null ? `>${Math.round(LEAK_MAX_MS / 1000)}` : Math.round(gone / 100) / 10, states: seen.join(" -> ") };
}

const mod: TestModule = {
  id: "MS04",
  title: "Role-level timeouts through the poolers: a leaked serverless transaction is freed at the role's idle timeout",
  where: "local",
  requires: ["pat", "db"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const pw = ctx.dbPassword;
    const sv = await primaryPooler(ctx);
    const ded = dedicatedTarget(ctx);
    const shared = sv ? sharedTargets(sv).txn : null;
    const roles = ["ms_app", "ms_app_nolimit"];

    const setup = await sql(
      ctx,
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname='ms_app') then create role ms_app login nobypassrls; end if;
         if not exists (select 1 from pg_roles where rolname='ms_app_nolimit') then create role ms_app_nolimit login nobypassrls; end if;
       end $$;
       alter role ms_app with password '${pw.replace(/'/g, "''")}';
       alter role ms_app_nolimit with password '${pw.replace(/'/g, "''")}';
       alter role ms_app set idle_in_transaction_session_timeout = '${IDLE_TIMEOUT}';
       alter role ms_app set statement_timeout = '${STMT_TIMEOUT}';
       grant connect on database postgres to ms_app, ms_app_nolimit;`,
    );
    if (setup.status >= 300) return [{ id: "MS04", title: mod.title, status: "fail", detail: `role setup failed HTTP ${setup.status}: ${setup.error}` }];

    try {
      // MS04a - the GUC as seen through each pooler.
      const gucRows: string[] = [];
      const m: Record<string, string | number> = {};
      for (const [label, t, user] of [
        ["dedicated_6543", ded, "ms_app"],
        ...(shared ? [["shared_6543", shared, `ms_app.${ctx.ref}`] as const] : []),
      ] as [string, PgTarget, string][]) {
        const c = pgClient(t, pw, 10_000, user);
        try {
          await c.connect();
          const r = await c.query<{ a: string; b: string }>("select current_setting('idle_in_transaction_session_timeout') as a, current_setting('statement_timeout') as b");
          m[`${label}_idle_timeout`] = r.rows[0]?.a ?? "";
          m[`${label}_statement_timeout`] = r.rows[0]?.b ?? "";
          gucRows.push(`${label} as ${user}: idle_in_transaction_session_timeout=${r.rows[0]?.a} statement_timeout=${r.rows[0]?.b}`);
        } catch (e) {
          m[`${label}_idle_timeout`] = `connect failed`;
          gucRows.push(`${label} as ${user}: ${errText(e)}`);
        } finally {
          await c.end().catch(() => {});
        }
      }
      out.push({
        id: "MS04a",
        title: "role GUCs as a pooled connection sees them",
        status: m.dedicated_6543_idle_timeout === IDLE_TIMEOUT ? "pass" : "fail",
        detail: gucRows.join("; "),
        measurements: m,
      });

      // MS04b - statement_timeout through the dedicated pooler.
      {
        const c = pgClient(ded, pw, 10_000, "ms_app");
        const t0 = Date.now();
        let code = "";
        let msg = "";
        try {
          await c.connect();
          await c.query("select pg_sleep(10)");
          msg = "pg_sleep(10) completed - no timeout fired";
        } catch (e) {
          code = String((e as { code?: string }).code ?? "");
          msg = errText(e);
        } finally {
          await c.end().catch(() => {});
        }
        const wall = Date.now() - t0;
        out.push({
          id: "MS04b",
          title: `statement_timeout '${STMT_TIMEOUT}' on the role vs pg_sleep(10) through dedicated 6543`,
          status: code === "57014" ? "pass" : "fail",
          detail: `SQLSTATE ${code || "none"} after ${wall}ms: ${msg}`,
          measurements: { sqlstate: code, wall_ms: wall, message: msg },
        });
      }

      // MS04c - the leaked transaction, with the timeout.
      const leakRows: TestResult["measurements"] = {};
      const leakDetail: string[] = [];
      const l1 = await leak(ctx, ded, "ms_app", pw);
      leakRows.dedicated_pid_gone_s = l1.goneS;
      leakRows.dedicated_states = l1.states || l1.error || "";
      leakDetail.push(`dedicated: pid ${l1.pid} gone after ${l1.goneS}s (${l1.states || l1.error})`);
      if (shared) {
        const l2 = await leak(ctx, shared, `ms_app.${ctx.ref}`, pw);
        leakRows.shared_pid_gone_s = l2.goneS;
        leakRows.shared_states = l2.states || l2.error || "";
        leakDetail.push(`shared: pid ${l2.pid} gone after ${l2.goneS}s (${l2.states || l2.error})`);
      }
      out.push({
        id: "MS04c",
        title: `leaked open transaction (socket destroyed, no COMMIT) with idle_in_transaction_session_timeout '${IDLE_TIMEOUT}' on the role`,
        status: typeof l1.goneS === "number" ? "pass" : "fail",
        detail: leakDetail.join("; "),
        measurements: leakRows,
      });

      // MS04d - the control without a timeout.
      const l3 = await leak(ctx, ded, "ms_app_nolimit", pw);
      out.push({
        id: "MS04d",
        title: "control: the same leak on a role with no idle_in_transaction_session_timeout",
        status: "info",
        detail: `dedicated: pid ${l3.pid} ${typeof l3.goneS === "number" ? `gone after ${l3.goneS}s` : `still present after ${LEAK_MAX_MS / 1000}s`} (${l3.states || l3.error})`,
        measurements: { nolimit_pid_gone_s: l3.goneS, nolimit_states: l3.states || l3.error || "" },
      });

      // MS04e/f - the client is ALIVE but stuck: transaction open, no statement
      // sent. The first run (2026-09-30) showed a DEAD client's backend is
      // closed by the pooler itself within ~2 s regardless of the role setting,
      // so the role timeout only matters for this case.
      for (const [id, user, title] of [
        ["MS04e", "ms_app", `alive client idle in transaction, role timeout '${IDLE_TIMEOUT}': seconds until the server ends it, and the client's error`],
        ["MS04f", "ms_app_nolimit", "control: alive client idle in transaction on the role with no timeout (bounded 30 s)"],
      ] as [string, string, string][]) {
        const c = pgClient(ded, pw, 10_000, user);
        c.on("error", () => {});
        let pid: number | null = null;
        let goneS: number | string = "n/a";
        let clientCode = "";
        let clientMsg = "";
        const bound = user === "ms_app" ? 30_000 : 30_000;
        try {
          await c.connect();
          await c.query("begin");
          pid = Number((await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid);
          const t0 = Date.now();
          while (Date.now() - t0 < bound) {
            const q = await sql(ctx, `select 1 from pg_stat_activity where pid = ${pid}`);
            if (!q.rows.length) {
              goneS = Math.round((Date.now() - t0) / 100) / 10;
              break;
            }
            await sleep(1000);
          }
          try {
            await c.query("select 1");
            clientMsg = "next statement succeeded - the transaction was still open";
          } catch (e) {
            clientCode = String((e as { code?: string }).code ?? "");
            clientMsg = errText(e);
          }
        } catch (e) {
          clientMsg = errText(e);
        } finally {
          await c.end().catch(() => {});
        }
        out.push({
          id,
          title,
          status: user === "ms_app" ? (typeof goneS === "number" ? "pass" : "fail") : "info",
          detail: `pid ${pid} ${typeof goneS === "number" ? `gone after ${goneS}s` : `still present after ${bound / 1000}s`}; client then saw ${clientCode ? `SQLSTATE ${clientCode}: ` : ""}${clientMsg}`,
          measurements: { pid_gone_s: goneS, client_sqlstate: clientCode, client_message: clientMsg.slice(0, 160) },
        });
      }
    } finally {
      await sql(ctx, `select pg_terminate_backend(pid) from pg_stat_activity where usename in ('ms_app','ms_app_nolimit')`).catch(() => {});
      await sleep(2000);
      await sql(ctx, `drop role if exists ${roles.join(", ")}`).catch(() => {});
    }
    return out;
  },
};
export default mod;
