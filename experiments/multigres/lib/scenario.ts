/**
 * One fault-injection run: warm up under write load, inject a fault at the
 * current primary, keep writing until the stream has recovered, then compare
 * the client-side commit log against the table.
 */
import type { Ctx, TestResult } from "../../../harness/src/types";
import {
  cells,
  clockOffsetMs,
  connect,
  containerOf,
  dexec,
  gatewayOf,
  orchTimeline,
  primaryOf,
  promotionEvents,
  psql,
  recreate,
  waitHealthy,
  type CellInfo,
} from "./cluster";
import { analyse, readPresent, startWriters } from "./load";

export interface Fault {
  /** what the module reports */
  label: string;
  /** Runs under load BEFORE the fault clock starts (e.g. let a standby fall behind). */
  prepare?(container: string, primary: CellInfo): Promise<string>;
  /** Injects the fault. Must return once the fault is in effect. */
  inject(container: string, primary: CellInfo): Promise<string>;
  /** Called after `holdMs` when the fault is reversible (SIGSTOP). */
  release?(container: string, primary: CellInfo): Promise<string>;
  holdMs?: number;
  /** Service id of the standby that was held back, for faults that do that. */
  laggardServiceId?(): string | undefined;
}

export interface ScenarioOpts {
  id: string;
  title: string;
  fault: Fault;
  workers?: number;
  warmMs?: number;
  /** After the stream recovers, keep writing this long so a late flap shows up. */
  tailMs?: number;
  maxObserveMs?: number;
  /** Start from a freshly created cluster (needed after a fault nothing undoes). */
  fresh?: boolean;
  /** How long to wait for 1 primary + 2 standbys after the run. */
  healMaxMs?: number;
  /** Writer pool shape; defaults to 8 closed-loop workers. */
  pauseMs?: number;
}

/** A child tree of `pid`, found with `ps -eo pid,ppid`. */
export async function descendants(container: string, pid: number): Promise<number[]> {
  const r = await dexec(container, ["ps", "-eo", "pid,ppid"]);
  const kids = new Map<number, number[]>();
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const a = kids.get(Number(m[2])) ?? [];
    a.push(Number(m[1]));
    kids.set(Number(m[2]), a);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(pid);
  return out;
}

export async function runScenario(ctx: Ctx, o: ScenarioOpts): Promise<TestResult> {
  const container = containerOf(ctx);
  const gw = gatewayOf(ctx, 1);
  const workers = o.workers ?? 8;
  const table = `mg_commits_${o.id.toLowerCase()}`;
  const evidence: string[] = [];
  const ev = (s: string) => {
    evidence.push(s);
    ctx.log(`${o.id} ${s}`);
  };

  if (o.fresh) {
    const r = await recreate(ctx, ctx.log);
    ev(`fresh cluster: ${r.ok ? "healthy" : "NOT healthy"} after ${r.ms} ms`);
  }
  const pre = await waitHealthy(container, 180_000, ctx.log);
  if (!pre.ok) {
    return { id: o.id, title: o.title, status: "skip", detail: "cluster not healthy (1 primary + 2 standbys) before the run" };
  }

  const admin = await connect(gw.host, gw.port);
  await admin.query(`drop table if exists ${table}`);
  await admin.query(`create table ${table}(w int not null, n int not null, ts timestamptz not null default clock_timestamp(), primary key (w, n))`);
  await admin.end();

  const cs0 = await cells(container);
  const primary = primaryOf(cs0);
  if (!primary) return { id: o.id, title: o.title, status: "skip", detail: "no primary found" };
  ev(`primary before: ${primary.cell} service ${primary.serviceId} pg port ${primary.pgPort}`);

  const w = startWriters({ host: gw.host, port: gw.port, workers, table, queryTimeoutMs: 20_000, pauseMs: o.pauseMs });
  await Bun.sleep(o.warmMs ?? 10_000);
  if (o.fault.prepare) ev(`prepare: ${await o.fault.prepare(container, primary)}`);
  const offsetMs = await clockOffsetMs(container);
  // tFault is taken BEFORE the docker exec that delivers the signal, so every
  // window below includes the exec latency (reported next to it).
  const tFault = Date.now();
  const injected = await o.fault.inject(container, primary);
  ev(`fault injected (${o.fault.label}); docker exec took ${Date.now() - tFault} ms: ${injected}`);

  if (o.fault.release) {
    await Bun.sleep(o.fault.holdMs ?? 20_000);
    const rel = await o.fault.release(container, primary);
    ev(`fault released at +${Date.now() - tFault} ms: ${rel}`);
  }

  // Observe until the last error is older than tailMs, bounded by maxObserveMs.
  const tail = o.tailMs ?? 15_000;
  const maxObs = o.maxObserveMs ?? 120_000;
  while (Date.now() - tFault < maxObs) {
    await Bun.sleep(1000);
    const errs = w.events.filter((e) => !e.ok && e.t1 >= tFault);
    const lastErr = errs.length ? Math.max(...errs.map((e) => e.t1)) : tFault;
    const acksAfter = w.events.some((e) => e.ok && e.t1 > lastErr);
    if (acksAfter && Date.now() - lastErr >= tail && Date.now() - tFault >= 20_000) break;
  }
  await w.stop();

  const post = await waitHealthy(container, o.healMaxMs ?? 120_000, ctx.log);
  const promos = await promotionEvents(container, tFault, offsetMs);
  ev(`container clock minus host clock: ${Math.round(offsetMs)} ms`);
  for (const p of promos) {
    ev(`multiorch primary.promotion at fault +${p.atMs} ms: ${p.outcome} reason=${p.reason} new_primary=${p.newPrimary} ${p.extra}`.trimEnd());
  }
  const timeline = await orchTimeline(container, tFault, offsetMs);
  if (timeline.length) ev(`multiorch leadership log since the fault (container clock corrected to host):\n  ${timeline.join("\n  ")}`);
  const cs1 = await cells(container);
  const primary1 = primaryOf(cs1);
  ev(`primary after: ${primary1 ? `${primary1.cell} service ${primary1.serviceId}` : "none"}; cluster back to 1 primary + 2 standbys: ${post.ok} (${post.ms} ms after writers stopped)`);

  let present: Set<string>;
  try {
    present = await readPresent(gw.host, gw.port, table);
  } catch (e) {
    return {
      id: o.id,
      title: o.title,
      status: "fail",
      detail: `could not read the table back through the gateway: ${e instanceof Error ? e.message : String(e)}`,
      evidence: evidence.join("\n"),
    };
  }
  const a = analyse(w.events, present, tFault);

  // Per-node row counts: lost commits can hide on a node the gateway does not read.
  const counts: string[] = [];
  for (const c of cs1) {
    const n = c.inRecovery === null ? null : await psql(container, c.pgPort, `select count(*) from ${table}`);
    counts.push(`${c.cell}:${n ?? "down"}${c.inRecovery ? "(standby)" : c.inRecovery === false ? "(primary)" : ""}`);
  }
  ev(`row counts per node after recovery: ${counts.join(" ")}; gateway read: ${present.size}`);
  ev(`error modes: ${a.errorModes.map(([m, n]) => `${n} x ${m}`).join(" | ") || "none"}`);
  const cw = w.connectWaits;
  ev(
    `connects that took over 200 ms: ${cw.length}` +
      (cw.length ? `, longest ${Math.max(...cw.map((c) => c.ms))} ms, first started at fault +${Math.min(...cw.map((c) => c.t)) - tFault} ms` : ""),
  );
  const ce = w.connectErrors;
  const ceModes = new Map<string, number>();
  for (const c of ce) ceModes.set(c.err, (ceModes.get(c.err) ?? 0) + 1);
  ev(
    `failed (re)connects: ${ce.length}` +
      (ce.length
        ? `, first at fault +${Math.min(...ce.map((c) => c.t)) - tFault} ms, last at +${Math.max(...ce.map((c) => c.t)) - tFault} ms: ${[...ceModes.entries()].map(([m, n]) => `${n} x ${m}`).join(" | ")}`
        : ""),
  );

  const changed = !!primary1 && primary1.serviceId !== primary.serviceId;
  return {
    id: o.id,
    title: o.title,
    status: a.lost === 0 ? "pass" : "fail",
    detail: `${a.acked} acked, ${a.lost} acknowledged-but-lost, ${a.committedUnacked} committed-unacked of ${a.errored} errored; ack stall ${a.stallMs ?? "n/a"} ms`,
    measurements: {
      fault: o.fault.label,
      workers,
      tps_before: a.tpsBefore ?? "n/a",
      tps_after: a.tpsAfter ?? "n/a",
      attempts: a.attempts,
      acked: a.acked,
      errored: a.errored,
      failed_connects: ce.length,
      slow_connects_over_200ms: cw.length,
      longest_connect_ms: cw.length ? Math.max(...cw.map((c) => c.ms)) : 0,
      acked_but_lost: a.lost,
      committed_unacked: a.committedUnacked,
      errored_absent: a.erroredAbsent,
      ack_stall_ms: a.stallMs ?? "n/a",
      first_error_after_fault_ms: a.firstErrorAfterFaultMs ?? "n/a",
      last_error_after_fault_ms: a.lastErrorAfterFaultMs ?? "n/a",
      recovered_ms: a.recoveredMs ?? "n/a",
      max_statement_latency_ms: a.maxLatencyMs,
      primary_changed: changed ? "yes" : "no",
      ...(o.fault.laggardServiceId
        ? { promoted_the_lagging_standby: primary1 && primary1.serviceId === o.fault.laggardServiceId() ? "yes" : "no" }
        : {}),
      healed_to_1p2s: post.ok ? "yes" : "no",
      heal_wait_ms: post.ms,
    },
    evidence: evidence.join("\n"),
  };
}
