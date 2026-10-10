/**
 * PC02 - client-side fallback when the transaction pool will not give a
 * backend: how long does the switch take, per fallback target?
 *
 * The primary path is Supavisor transaction mode (6543) held at pool size with
 * `pg_sleep` (PC01 shows the pool size and the error). The fallback policy is
 * the one an app can write today: put a client-side deadline on the statement,
 * and when it fires (or the server answers `ECHECKOUTTIMEOUT`) open a fresh
 * connection on another path and run the statement there. "Switch" is the time
 * from the primary's failure to the fallback's first answer; "total" adds the
 * deadline the client waited. Fallback targets:
 *
 *   PC02a  Supavisor session mode (5432, same host and user as the primary)
 *   PC02b  direct 5432 (`db.<ref>`): the host has no IPv4 address without the IPv4
 *          add-on, so an IPv4-only client cannot reach it (measured here)
 *   PC02c  after the full server-side wait: the same session-mode fallback
 *          after the real `ECHECKOUTTIMEOUT` rather than a 3 s client deadline, 3 trials
 *   PC02d  IPv4 add-on switched on: seconds until `db.<ref>` resolves to an
 *          IPv4 address (OS resolver, as the client sees it) and the dedicated pooler (6543) answers
 *   PC02e  with the add-on: dedicated pooler (PgBouncer, 6543, user postgres)
 *          as the fallback, 3 trials
 *   PC02f  with the add-on: direct 5432 as the fallback, 3 trials
 *
 * The add-on is billable (about USD 0.0055/h) and is removed before the
 * module returns; the project goes with PC09. Not settled: fallback under
 * load (a session-mode client holds a backend for its whole connection, so a
 * herd of fallbacks can exhaust that pool too), IPv6-capable vantages.
 */
import { lookup } from "node:dns/promises";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { activeSleepers, dedicated, direct, holdPool, sharedSession, sharedTxn, timedQuery, type Outcome, type Target } from "../lib/pg";
import { acquireProject, sleep, stallGuard, type PcProject } from "../lib/project";

const DEADLINE_MS = 3000;

interface Switch {
  primary: Outcome;
  fallback: Outcome;
  switchMs: number;
  totalMs: number;
}

async function failover(p: PcProject, primary: Target, fallback: Target, deadlineMs: number): Promise<Switch> {
  const t0 = Date.now();
  const a = await timedQuery(primary, p.password, "select 1", deadlineMs);
  const tFail = Date.now();
  const b = await timedQuery(fallback, p.password, "select 1", 30_000, 10_000);
  return { primary: a, fallback: b, switchMs: Date.now() - tFail, totalMs: Date.now() - t0 };
}

const stat = (xs: number[]) => (xs.length ? `${Math.min(...xs)}-${Math.max(...xs)}` : "n/a");

function row(id: string, title: string, runs: Switch[], target: Target): TestResult {
  const okRuns = runs.filter((r) => r.fallback.ok);
  const primaryCodes = [...new Set(runs.map((r) => r.primary.code || "ok"))].join(",");
  const fbErr = runs.find((r) => !r.fallback.ok)?.fallback;
  return {
    id,
    title,
    status: okRuns.length === runs.length ? "pass" : okRuns.length === 0 ? "fail" : "info",
    detail: `${okRuns.length}/${runs.length} fallbacks to ${target.label} answered; switch ms ${stat(okRuns.map((r) => r.switchMs))}; primary outcome ${primaryCodes}${fbErr ? `; fallback error ${fbErr.code} ${fbErr.error}` : ""}`,
    measurements: {
      fallback: target.label,
      trials: runs.length,
      fallback_ok: okRuns.length,
      switch_ms_min: okRuns.length ? Math.min(...okRuns.map((r) => r.switchMs)) : "n/a",
      switch_ms_max: okRuns.length ? Math.max(...okRuns.map((r) => r.switchMs)) : "n/a",
      total_ms_min: okRuns.length ? Math.min(...okRuns.map((r) => r.totalMs)) : "n/a",
      total_ms_max: okRuns.length ? Math.max(...okRuns.map((r) => r.totalMs)) : "n/a",
      primary_codes: primaryCodes,
      primary_ms_first: runs[0]?.primary.queryMs ?? "n/a",
      fallback_error: fbErr ? `${fbErr.code}: ${fbErr.error}` : "none",
    },
  };
}

async function addonSelected(ctx: Ctx): Promise<{ selected: string[]; available: string[] }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/billing/addons`);
  const j = (r.json ?? {}) as { selected_addons?: { type: string }[]; available_addons?: { type: string }[] };
  return { selected: (j.selected_addons ?? []).map((a) => a.type), available: (j.available_addons ?? []).map((a) => a.type) };
}

const mod: TestModule = {
  id: "PC02",
  title: "Fallback from an exhausted transaction pool: switch time to session pooler, direct, dedicated pooler",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC02");
    const p = await acquireProject(ctx);
    const txn = sharedTxn(p);
    const sess = sharedSession(p);
    const dir = direct(p);
    const ded = dedicated(p);

    // pool size: re-measure rather than carry PC01's number, so PC02 runs alone
    const probe = holdPool(txn, p.password, 40, 12);
    await sleep(5000);
    const pool = Math.max((await activeSleepers(p.ctx)).active, 1);
    await probe.done;
    await sleep(2000);

    // ---- phase A: no add-on (IPv4-only vantage)
    const holdersA = holdPool(txn, p.password, pool, 40);
    await sleep(4000);
    const heldA = await activeSleepers(p.ctx);
    out.push({
      id: "PC02-hold",
      title: "PC02: primary pool held",
      status: heldA.active >= pool ? "info" : "fail",
      detail: `${heldA.active} of ${pool} backends active under pg_sleep(40) before the fallback trials`,
      measurements: { pool_size: pool, held_backends: heldA.active },
    });

    const sa: Switch[] = [];
    for (let i = 0; i < 3; i++) sa.push(await failover(p, txn, sess, DEADLINE_MS));
    out.push(row("PC02a", `PC02a: ${DEADLINE_MS} ms client deadline on 6543, fall back to session pooler 5432`, sa, sess));

    const sb: Switch[] = [];
    for (let i = 0; i < 3; i++) sb.push(await failover(p, txn, dir, DEADLINE_MS));
    const addrs = async (family: 4 | 6): Promise<string[]> =>
      (await lookup(dir.host, { family, all: true }).catch(() => [])).map((a) => a.address);
    const [a4, a6] = await Promise.all([addrs(4), addrs(6)]);
    const rowB = row("PC02b", `PC02b: ${DEADLINE_MS} ms client deadline on 6543, fall back to direct 5432 (no IPv4 add-on)`, sb, dir);
    rowB.measurements = { ...rowB.measurements, direct_host_ipv4_addresses: a4.length, direct_host_ipv6_addresses: a6.length };
    out.push(rowB);

    await holdersA.done;
    await sleep(3000);

    // PC02h: do the session-mode fallback's backends come out of the same pool? The connection-management guide
    // says session and transaction mode share one pool size; count active sleepers with both modes busy.
    const hh = holdPool(txn, p.password, pool, 30);
    await sleep(4000);
    const sessHold = timedQuery(sess, p.password, "select pg_sleep(15)", 60_000);
    await sleep(4000);
    const both = await activeSleepers(p.ctx);
    const so = await sessHold;
    await hh.done;
    out.push({
      id: "PC02h",
      title: `PC02h: ${pool} transaction-mode backends held plus one session-mode client running pg_sleep(15)`,
      status: so.ok ? "info" : "fail",
      detail: `${both.active} active pg_sleep backends with both modes busy (${pool} from 6543 + 1 from 5432 if the pools are separate); the session-mode client ${so.ok ? "completed" : "failed: " + so.code + " " + so.error}`,
      measurements: {
        pool_size: pool,
        active_sleepers_both_modes: both.active,
        session_client_ok: so.ok ? "yes" : "no",
        session_client_total_ms: so.totalMs,
        session_client_connect_ms: so.connectMs ?? "failed",
      },
    });
    await sleep(3000);

    // PC02c: wait for the server's own answer (client deadline 90 s > the 60 s checkout timeout), then fall back.
    // Fresh holders per trial, so each trial sees a full pool and one 60 s wait.
    const sc: Switch[] = [];
    for (let i = 0; i < 3; i++) {
      const h = holdPool(txn, p.password, pool, 100);
      await sleep(4000);
      sc.push(await failover(p, txn, sess, 90_000));
      await h.done;
      await sleep(3000);
    }
    out.push(row("PC02c", "PC02c: wait for the server's ECHECKOUTTIMEOUT (no client deadline), then fall back to session pooler 5432", sc, sess));

    // ---- phase B: IPv4 add-on
    const ad = await addonSelected(p.ctx);
    if (!ad.available.includes("ipv4") && !ad.selected.includes("ipv4")) {
      out.push({ id: "PC02d", title: "PC02d: IPv4 add-on", status: "skip", detail: `ipv4 not in available_addons [${ad.available.join(",")}]` });
      out.push(guard.result());
      return out;
    }
    const tOn = Date.now();
    let patch = await mgmt(p.ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "ipv4", addon_variant: "ipv4_default" });
    for (let a = 0; patch.status === 429 && a < 3; a++) {
      await sleep(65_000);
      patch = await mgmt(p.ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "ipv4", addon_variant: "ipv4_default" });
    }
    let tA: number | null = null;
    let tDed: number | null = null;
    let tDir: number | null = null;
    let lastDed = "";
    try {
      while (Date.now() - tOn < 10 * 60_000 && (tDed === null || tDir === null)) {
        if (tA === null && (await lookup(dir.host, { family: 4, all: true }).catch(() => [])).length) tA = Date.now() - tOn;
        if (tDed === null) {
          const r = await timedQuery(ded, p.password, "select 1", 8000, 8000);
          if (r.ok) tDed = Date.now() - tOn;
          else lastDed = `${r.code} ${r.error}`;
        }
        if (tDir === null) {
          const r = await timedQuery(dir, p.password, "select 1", 8000, 8000);
          if (r.ok) tDir = Date.now() - tOn;
        }
        await sleep(5000);
      }
      out.push({
        id: "PC02d",
        title: "PC02d: IPv4 add-on switched on - time until db.<ref> is reachable from an IPv4-only client",
        status: tDed !== null ? "info" : "fail",
        detail: `PATCH billing/addons HTTP ${patch.status}; IPv4 address after ${tA === null ? "never" : Math.round(tA / 1000) + " s"}; dedicated 6543 answered after ${tDed === null ? "never (" + lastDed + ")" : Math.round(tDed / 1000) + " s"}; direct 5432 after ${tDir === null ? "never" : Math.round(tDir / 1000) + " s"} (poll step 5 s plus probe time)`,
        measurements: {
          patch_status: patch.status,
          ipv4_address_s: tA === null ? "never" : Math.round(tA / 1000),
          dedicated_6543_s: tDed === null ? "never" : Math.round(tDed / 1000),
          direct_5432_s: tDir === null ? "never" : Math.round(tDir / 1000),
        },
      });

      if (tDed !== null && tDir !== null) {
        const holdersB = holdPool(txn, p.password, pool, 90);
        await sleep(4000);
        const heldB = await activeSleepers(p.ctx);
        const se: Switch[] = [];
        for (let i = 0; i < 3; i++) se.push(await failover(p, txn, ded, DEADLINE_MS));
        const rowE = row("PC02e", `PC02e: ${DEADLINE_MS} ms client deadline on 6543, fall back to dedicated pooler 6543 (add-on on)`, se, ded);
        rowE.measurements = { ...rowE.measurements, held_backends: heldB.active };
        out.push(rowE);
        const sf: Switch[] = [];
        for (let i = 0; i < 3; i++) sf.push(await failover(p, txn, dir, DEADLINE_MS));
        out.push(row("PC02f", `PC02f: ${DEADLINE_MS} ms client deadline on 6543, fall back to direct 5432 (add-on on)`, sf, dir));
        await holdersB.done;
      }
    } finally {
      // The add-on endpoints answer 429 "try again in N minute(s)" shortly after the PATCH.
      let del = await mgmt(p.ctx, "DELETE", `/projects/${p.ref}/billing/addons/ipv4_default`);
      for (let a = 0; del.status === 429 && a < 5; a++) {
        const m = /try again in (\d+)/.exec(del.text);
        await sleep((m ? Number(m[1]) : 1) * 60_000 + 5000);
        del = await mgmt(p.ctx, "DELETE", `/projects/${p.ref}/billing/addons/ipv4_default`);
      }
      await sleep(5000);
      const after = await addonSelected(p.ctx);
      out.push({
        id: "PC02g",
        title: "PC02g: IPv4 add-on removed",
        status: after.selected.includes("ipv4") ? "fail" : "info",
        detail: `DELETE billing/addons/ipv4_default HTTP ${del.status}${del.status >= 300 ? ` (${del.text.slice(0, 100)})` : ""}; ipv4 still selected: ${after.selected.includes("ipv4")}`,
        measurements: { delete_status: del.status, ipv4_selected_after: after.selected.includes("ipv4") ? "yes" : "no" },
      });
    }
    out.push(guard.result());
    return out;
  },
};

export default mod;
