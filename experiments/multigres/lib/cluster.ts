/**
 * Helpers for the all-in-one Multigres container (see the Makefile). The
 * container runs etcd, multiadmin and, per cell, pgctld + postgres,
 * multipooler, multiorch and multigateway as child processes. Faults are
 * injected with `docker exec kill`, so the vantage is "the Docker host talking
 * to one container", not a Kubernetes cluster.
 */
import { Client } from "pg";
import type { Ctx } from "../../../harness/src/types";

export const DEFAULT_CONTAINER = "multigres-lab";
export const PG_PASSWORD = "postgres";

export interface Exec {
  code: number;
  out: string;
  err: string;
}

export async function run(cmd: string[], timeoutMs = 30_000): Promise<Exec> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err };
}

export const containerOf = (ctx: Ctx): string => ctx.endpoints.container ?? DEFAULT_CONTAINER;

/** host:port of the zone1 multigateway as seen from the Docker host; cell 2 and 3 use consecutive ports. */
export function gatewayOf(ctx: Ctx, cell = 1): { host: string; port: number } {
  const raw = ctx.endpoints.gateway;
  if (raw) {
    const [h, p] = raw.split(":");
    return { host: h || "127.0.0.1", port: Number(p || 15432) + (cell - 1) };
  }
  return { host: "127.0.0.1", port: 15432 + (cell - 1) };
}

export const dexec = (container: string, args: string[], timeoutMs?: number) =>
  run(["docker", "exec", container, ...args], timeoutMs);

export async function containerRunning(container: string): Promise<boolean> {
  const r = await run(["docker", "inspect", "-f", "{{.State.Running}}", container]).catch(() => null);
  return !!r && r.code === 0 && r.out.trim() === "true";
}

export interface CellInfo {
  cell: string; // zone1..3
  serviceId: string;
  pgPort: number;
  dataDir: string;
  pgctldPid: number | null;
  poolerPid: number | null;
  postmasterPid: number | null;
  /** null when postgres is not answering */
  inRecovery: boolean | null;
}

type Proc = Omit<CellInfo, "postmasterPid" | "inRecovery">;

/** Parse `ps -eo pid,args` output into per-cell process info. Pure; unit-tested. */
export function parsePs(ps: string): Proc[] {
  const cells = new Map<string, Proc>();
  const get = (sid: string): Proc => {
    let c = cells.get(sid);
    if (!c) {
      c = { cell: "", serviceId: sid, pgPort: 0, dataDir: "", pgctldPid: null, poolerPid: null };
      cells.set(sid, c);
    }
    return c;
  };
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[2]!;
    if (args.includes("bin/pgctld server")) {
      const dir = args.match(/--pooler-dir (\S+)/)?.[1];
      const port = args.match(/--pg-port (\d+)/)?.[1];
      const sid = dir?.match(/pooler_([a-z0-9]+)$/)?.[1];
      if (!dir || !port || !sid) continue;
      const c = get(sid);
      c.pgctldPid = pid;
      c.pgPort = Number(port);
      c.dataDir = dir;
    } else if (args.includes("bin/multipooler")) {
      const sid = args.match(/--service-id (\S+)/)?.[1];
      const cell = args.match(/--cell (\S+)/)?.[1];
      if (!sid) continue;
      const c = get(sid);
      c.poolerPid = pid;
      if (cell) c.cell = cell;
    }
  }
  return [...cells.values()].sort((a, b) => a.pgPort - b.pgPort);
}

export async function psql(container: string, port: number, sql: string): Promise<string | null> {
  const r = await run(
    [
      "docker", "exec", "-e", `PGPASSWORD=${PG_PASSWORD}`, container,
      "psql", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
      "-tAc", sql,
    ],
    10_000,
  );
  return r.code === 0 ? r.out.trim() : null;
}

export async function cells(container: string): Promise<CellInfo[]> {
  const ps = await dexec(container, ["ps", "-eo", "pid,args", "--width", "900"]);
  const out: CellInfo[] = [];
  for (const c of parsePs(ps.out)) {
    const pidFile = await dexec(container, ["head", "-1", `${c.dataDir}/pg_data/postmaster.pid`]);
    const pm = pidFile.code === 0 ? Number(pidFile.out.trim()) : NaN;
    const alive = Number.isFinite(pm) ? (await dexec(container, ["kill", "-0", String(pm)])).code === 0 : false;
    const rec = alive ? await psql(container, c.pgPort, "select pg_is_in_recovery()") : null;
    out.push({ ...c, postmasterPid: alive ? pm : null, inRecovery: rec === null ? null : rec === "t" });
  }
  return out;
}

export const primaryOf = (cs: CellInfo[]): CellInfo | undefined => cs.find((c) => c.inRecovery === false);

/** Exactly one primary and every postgres answering. */
export const healthy = (cs: CellInfo[], n = 3): boolean =>
  cs.length === n && cs.filter((c) => c.inRecovery === false).length === 1 && cs.every((c) => c.inRecovery !== null);

export async function waitHealthy(
  container: string,
  maxMs: number,
  log: (m: string) => void,
): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const cs = await cells(container).catch(() => []);
    if (healthy(cs)) return { ok: true, ms: Date.now() - t0 };
    await Bun.sleep(2000);
  }
  log("cluster did not return to 1 primary + 2 standbys");
  return { ok: false, ms: Date.now() - t0 };
}

export async function connect(host: string, port: number, timeoutMs = 5000): Promise<Client> {
  const c = new Client({
    host,
    port,
    user: "postgres",
    password: PG_PASSWORD,
    database: "postgres",
    connectionTimeoutMillis: timeoutMs,
  });
  c.on("error", () => {});
  await c.connect();
  return c;
}

/**
 * Throw the container away and start a fresh 3-cell cluster from the image.
 * The cluster has no volume, so a killed cell (nothing restarts it) is only
 * recoverable this way. Keep the flags in step with the Makefile `up` target.
 */
export async function recreate(ctx: Ctx, log: (m: string) => void): Promise<{ ok: boolean; ms: number }> {
  const container = containerOf(ctx);
  const image = ctx.endpoints.image ?? "multigres-cluster:local";
  const t0 = Date.now();
  await run(["docker", "rm", "-f", container], 60_000);
  const r = await run(
    [
      "docker", "run", "-d", "--name", container, "--init",
      "-e", "MULTIGRES_NUM_CELLS=3", "-e", "MULTIGRES_GATEWAY_PG_PORT=15432",
      "-p", "15432:15432", "-p", "15433:15433", "-p", "15434:15434",
      "-p", "15100:15100", "-p", "15000:15000",
      // direct postgres backends, for the control row of the feature matrix
      "-p", "25432:25432", "-p", "25433:25433", "-p", "25434:25434",
      image,
    ],
    60_000,
  );
  if (r.code !== 0) {
    log(`docker run failed: ${r.err.trim()}`);
    return { ok: false, ms: Date.now() - t0 };
  }
  const h = await waitHealthy(container, 240_000, log);
  return { ok: h.ok, ms: Date.now() - t0 };
}

/** Container clock minus host clock, ms, from one round trip (error is half the round trip). */
export async function clockOffsetMs(container: string): Promise<number> {
  const a = Date.now();
  const r = await dexec(container, ["date", "+%s%3N"]);
  const b = Date.now();
  return Number(r.out.trim()) - (a + b) / 2;
}

export interface PromotionEvent {
  /** ms after `tFault`, host clock (container clock corrected by the measured offset) */
  atMs: number;
  outcome: string;
  reason: string;
  newPrimary: string;
  extra: string;
}

/**
 * multiorch messages about leadership since the fault, `msg` only, one line each
 * (the three multiorchs log the same decisions, so identical text is kept once
 * per millisecond bucket of 100 ms). Replication-repair chatter is dropped.
 */
export async function orchTimeline(container: string, tFault: number, offsetMs: number, max = 40): Promise<string[]> {
  const r = await dexec(container, ["sh", "-c", "cat /multigres/cluster/logs/dbs/postgres/multiorch/*.log"]);
  const rows: { at: number; text: string }[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = Math.round(Date.parse(String(j.time)) - offsetMs - tFault);
    if (at < -500) continue;
    const msg = String(j.msg ?? "");
    if (!/leader|primary|promot|recruit|appoint|elect|demot|quorum|cohort|term/i.test(msg)) continue;
    if (/found primary for replication|primary_conninfo|fixing replication|fix replication|leader-info propagation/i.test(msg)) continue;
    const extra = ["pooler", "new_primary", "reason", "outcome", "error"]
      .filter((k) => j[k] !== undefined && j[k] !== "")
      .map((k) => `${k}=${String(j[k]).slice(0, 90)}`)
      .join(" ");
    rows.push({ at, text: `${msg} ${extra}`.trim() });
  }
  rows.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  let last = "";
  for (const x of rows) {
    const key = `${Math.floor(x.at / 100)}|${x.text}`;
    if (key === last) continue;
    last = key;
    out.push(`+${x.at} ms ${x.text}`);
    if (out.length >= max) break;
  }
  return out;
}

/** multiorch's structured `primary.promotion` events since the fault. */
export async function promotionEvents(container: string, tFault: number, offsetMs: number): Promise<PromotionEvent[]> {
  const r = await dexec(container, [
    "sh",
    "-c",
    "grep -h '\"event_type\":\"primary.promotion\"' /multigres/cluster/logs/dbs/postgres/multiorch/*.log",
  ]);
  const out: PromotionEvent[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = Date.parse(String(j.time)) - offsetMs - tFault;
    if (at < -2000) continue;
    const extra = Object.entries(j)
      .filter(([k]) => /_ms$/.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    out.push({
      atMs: Math.round(at),
      outcome: String(j.outcome ?? ""),
      reason: String(j.reason ?? ""),
      newPrimary: String(j.new_primary ?? ""),
      extra,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
