/**
 * PC05 - the pool-exhaustion checkout timeout across pooler mode and client
 * settings (card: 60,000 ms measured in PC01 vs 15,000 ms quoted elsewhere).
 *
 * Supavisor source (v2.9.x, lib/supavisor/client_handler.ex `pool_checkout`)
 * waits for a free pool slot for the tenant user's `pool_checkout_timeout`
 * (schema default 60_000). The Management API does not expose that field. The
 * rows ask whether anything a project owner holds moves the number:
 *
 *   PC05a  session mode (5432): 24 clients each `select pg_sleep(75)`. Session
 *          mode checks a backend out at connect, so the clients past the
 *          session pool size wait in connect(). Per trial: active sleepers at
 *          +6 s (Management API), and for each waiting client the time to its
 *          error and the verbatim text. 3 trials.
 *   PC05b  transaction mode (6543) with client settings: the pool is held by
 *          24 `pg_sleep(75)` clients, then four extra clients send `select 1`
 *          at once: plain; node-postgres `statement_timeout: 5000` (sent as a
 *          startup parameter); `options: -c statement_timeout=5000`; and
 *          `connectionTimeoutMillis: 5000`. Time to error and text for each.
 *          3 trials.
 *
 * PC07 changes the pool size; PC06 delays backend logins. Both run after this.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeSleepers, holdPool, type Outcome, sharedSession, sharedTxn, timedQuery } from "../lib/pg";
import { acquireProject, sleep, stallGuard } from "../lib/project";

const HOLD_S = 75;
const CROWD = 24;

const fmt = (o: Outcome) => (o.ok ? `ok ${o.queryMs} ms` : `${o.code} after ${o.totalMs} ms`);

const mod: TestModule = {
  id: "PC05",
  title: "Pool-exhaustion checkout timeout by pooler mode and client setting",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC05", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC05");
    const p = await acquireProject(ctx);

    // ---- PC05a: session mode
    for (let k = 1; k <= 3; k++) {
      // connect waits for the session checkout: give the client 120 s so the server answers first
      const crowd = holdPool(sharedSession(p), p.password, CROWD, HOLD_S, 120_000);
      await sleep(6000);
      const act = await activeSleepers(p.ctx);
      const res = await crowd.done;
      const waiters = res.filter((o) => !o.ok);
      const served = res.filter((o) => o.ok);
      const times = waiters.map((o) => o.totalMs).sort((a, b) => a - b);
      const texts = [...new Set(waiters.map((o) => `${o.code} ${o.error}`))];
      out.push({
        id: `PC05a-${k}`,
        title: `PC05a trial ${k}: ${CROWD} session-mode clients run pg_sleep(${HOLD_S}) on 5432`,
        status: waiters.length > 0 ? "pass" : "info",
        detail: `${act.active} active sleepers at +6 s; ${served.length} served, ${waiters.length} errored after ${times[0] ?? "-"} to ${times.at(-1) ?? "-"} ms; ${texts.join(" | ") || "no error"}`,
        measurements: {
          trial: k,
          mode: "session_5432",
          clients: CROWD,
          active_sleepers_at_6s: act.active,
          served: served.length,
          errored: waiters.length,
          errored_connect_failed: waiters.filter((o) => o.connectMs === null).length,
          error_total_ms_min: times[0] ?? "n/a",
          error_total_ms_max: times.at(-1) ?? "n/a",
          error_texts: texts.join(" | ") || "none",
        },
      });
      await sleep(5000);
    }

    // ---- PC05b: transaction mode, client settings
    const variants: { key: string; extra: Record<string, unknown>; connectTimeoutMs?: number }[] = [
      { key: "plain", extra: {} },
      { key: "pg_statement_timeout_5000", extra: { statement_timeout: 5000 } },
      { key: "options_statement_timeout_5000", extra: { options: "-c statement_timeout=5000" } },
      { key: "connect_timeout_5000", extra: {}, connectTimeoutMs: 5000 },
    ];
    for (let k = 1; k <= 3; k++) {
      const crowd = holdPool(sharedTxn(p), p.password, CROWD, HOLD_S);
      await sleep(5000);
      const act = await activeSleepers(p.ctx);
      const res = await Promise.all(
        variants.map((v) => timedQuery(sharedTxn(p), p.password, "select 1", 120_000, v.connectTimeoutMs ?? 30_000, v.extra)),
      );
      const crowdRes = await crowd.done;
      const m: Record<string, number | string> = {
        trial: k,
        mode: "transaction_6543",
        holders: CROWD,
        active_sleepers_at_5s: act.active,
        holders_errored: crowdRes.filter((o) => !o.ok).length,
      };
      variants.forEach((v, i) => {
        const o = res[i] as Outcome;
        m[`${v.key}_connect_ms`] = o.connectMs ?? "failed";
        m[`${v.key}_ok`] = o.ok ? "yes" : "no";
        m[`${v.key}_query_ms`] = o.queryMs ?? "n/a";
        m[`${v.key}_error`] = o.ok ? "none" : `${o.code} ${o.error}`;
      });
      out.push({
        id: `PC05b-${k}`,
        title: `PC05b trial ${k}: four extra transaction-mode clients with different settings while ${CROWD} pg_sleep(${HOLD_S}) clients hold the pool`,
        status: res.every((o) => !o.ok) ? "pass" : "info",
        detail: variants.map((v, i) => `${v.key}: ${fmt(res[i] as Outcome)}`).join("; "),
        measurements: m,
      });
      await sleep(5000);
    }
    out.push(guard.result());
    return out;
  },
};

export default mod;
