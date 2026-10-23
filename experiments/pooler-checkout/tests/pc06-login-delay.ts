/**
 * PC06 - the second source of `ECHECKOUTTIMEOUT`: a backend connection that is
 * not ready.
 *
 * Supavisor (v2.9.0 onwards, PR #841) raises the same error text from two
 * places: the pool-slot wait in `ClientHandler.pool_checkout` (the tenant
 * user's `pool_checkout_timeout`, 60 s on the projects PC01 measured) and the
 * call to the pooled `DbHandler` in `DbHandler.checkout/5`, whose timeout
 * defaults to a fixed 15_000 ms. The DbHandler postpones that call while it is
 * still connecting or authenticating to Postgres. A Postgres login that takes
 * longer than 15 s should therefore produce `after 15000ms` while the pool has
 * free slots. This module delays logins on purpose to test that reading.
 *
 * Mechanism: a Postgres 17 `login` event trigger that runs `pg_sleep(d)` for
 * sessions whose startup `application_name` is `Supavisor` (the name the
 * pooler's own backend connections carry), with d read from a table so the
 * Management API session (application_name `mgmt-api`) is never delayed.
 * Each trial sets d, terminates the pooler's idle backends through the
 * Management API, then starts the clients, so they meet backends that are
 * logging in.
 *
 *   PC06a  setup: the trigger is created (or the error recorded).
 *   PC06b  d = 0, transaction mode: 4 concurrent `select 1`, then 1 more. 3 trials.
 *   PC06c  d = 8 s, transaction mode, same shape. 3 trials.
 *   PC06d  d = 20 s, transaction mode, same shape. 3 trials.
 *   PC06e  d = 20 s, session mode (5432): 2 concurrent clients. 3 trials.
 *   PC06f  cleanup: trigger and schema dropped.
 */
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Outcome, sharedSession, sharedTxn, type Target, timedQuery } from "../lib/pg";
import { acquireProject, type PcProject, sleep, stallGuard } from "../lib/project";

const SETUP = `
drop event trigger if exists lab_login_delay;
create schema if not exists lab;
create table if not exists lab.login_delay(id int primary key, delay_s float8 not null);
insert into lab.login_delay values (1, 0) on conflict (id) do update set delay_s = 0;
create or replace function lab.login_delay_fn() returns event_trigger language plpgsql as $$
declare s float8;
begin
  if current_setting('application_name', true) = 'Supavisor' then
    select delay_s into s from lab.login_delay where id = 1;
    if coalesce(s, 0) > 0 then perform pg_sleep(s); end if;
  end if;
end $$;
create event trigger lab_login_delay on login execute function lab.login_delay_fn();
select evtname, evtevent, evtenabled from pg_event_trigger where evtname = 'lab_login_delay';`;

const describeOutcome = (o: Outcome) =>
  o.ok ? `ok (connect ${o.connectMs} ms, query ${o.queryMs} ms)` : `${o.code} after ${o.totalMs} ms: ${o.error}`;

async function trial(p: PcProject, t: Target, delayS: number, concurrent: number, followUp: boolean) {
  const set = await sql(p.ctx, `update lab.login_delay set delay_s = ${delayS} where id = 1`);
  const kill = await sql(
    p.ctx,
    "select count(*)::int n from (select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'Supavisor') x",
  );
  const killed = Number((kill.rows[0] as { n?: number } | undefined)?.n ?? -1);
  const t0 = Date.now();
  const first = await Promise.all(Array.from({ length: concurrent }, () => timedQuery(t, p.password, "select 1", 90_000, 90_000)));
  const second = followUp ? await timedQuery(t, p.password, "select 1", 90_000, 90_000) : null;
  return { setError: set.error, killed, first, second, wallMs: Date.now() - t0 };
}

function row(id: string, title: string, delayS: number, mode: string, r: Awaited<ReturnType<typeof trial>>, k: number): TestResult {
  const all = [...r.first, ...(r.second ? [r.second] : [])];
  const m: Record<string, number | string> = { trial: k, login_delay_s: delayS, mode, pooler_backends_terminated: r.killed };
  all.forEach((o, i) => {
    const key = r.second && i === all.length - 1 ? "followup" : `c${i + 1}`;
    m[`${key}_ok`] = o.ok ? "yes" : "no";
    m[`${key}_total_ms`] = o.totalMs;
    m[`${key}_error`] = o.ok ? "none" : `${o.code} ${o.error}`;
  });
  const n15 = all.filter((o) => /after 15000ms/.test(o.error)).length;
  m.checkout_timeout_15000_count = n15;
  m.ok_count = all.filter((o) => o.ok).length;
  return {
    id,
    title,
    status: "info",
    detail: all.map((o, i) => `${r.second && i === all.length - 1 ? "follow-up" : `c${i + 1}`}: ${describeOutcome(o)}`).join("; "),
    measurements: m,
    evidence: r.setError || undefined,
  };
}

const mod: TestModule = {
  id: "PC06",
  title: "Backend login slower than 15 s: ECHECKOUTTIMEOUT after 15000ms with free pool slots",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC06", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC06");
    const p = await acquireProject(ctx);

    const setup = await sql(p.ctx, SETUP);
    const ok = !setup.error && setup.rows.length === 1;
    out.push({
      id: "PC06a",
      title: "PC06a: login event trigger created",
      status: ok ? "pass" : "fail",
      detail: ok ? `trigger row: ${JSON.stringify(setup.rows[0])}` : `setup failed: HTTP ${setup.status} ${setup.error}`,
      measurements: { http_status: setup.status, created: ok ? "yes" : "no" },
    });
    if (!ok) return out;

    const cells: { id: string; delay: number; t: Target; mode: string; n: number; follow: boolean }[] = [
      { id: "PC06b", delay: 0, t: sharedTxn(p), mode: "transaction_6543", n: 4, follow: true },
      { id: "PC06c", delay: 8, t: sharedTxn(p), mode: "transaction_6543", n: 4, follow: true },
      { id: "PC06d", delay: 20, t: sharedTxn(p), mode: "transaction_6543", n: 4, follow: true },
      { id: "PC06e", delay: 20, t: sharedSession(p), mode: "session_5432", n: 2, follow: false },
    ];
    for (const c of cells) {
      for (let k = 1; k <= 3; k++) {
        const r = await trial(p, c.t, c.delay, c.n, c.follow);
        out.push(row(`${c.id}-${k}`, `${c.id} trial ${k}: login delay ${c.delay} s, ${c.mode}, ${c.n} concurrent clients${c.follow ? " then 1" : ""}`, c.delay, c.mode, r, k));
        // let delayed logins finish before the next trial
        await sql(p.ctx, "update lab.login_delay set delay_s = 0 where id = 1");
        await sleep((c.delay + 5) * 1000);
      }
    }

    const clean = await sql(p.ctx, "drop event trigger if exists lab_login_delay; drop schema if exists lab cascade; select count(*)::int n from pg_event_trigger where evtname = 'lab_login_delay'");
    const left = Number((clean.rows[0] as { n?: number } | undefined)?.n ?? -1);
    out.push({
      id: "PC06f",
      title: "PC06f: trigger and schema dropped",
      status: !clean.error && left === 0 ? "pass" : "fail",
      detail: clean.error || `${left} trigger rows left`,
      measurements: { triggers_left: left },
    });
    out.push(guard.result());
    return out;
  },
};

export default mod;
