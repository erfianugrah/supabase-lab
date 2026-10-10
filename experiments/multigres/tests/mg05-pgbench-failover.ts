/**
 * MG05 - pgbench write load through the multigateway while the primary's
 * postgres is SIGKILLed 10 s in.
 *
 * pgbench is the load generator the failover brief named. Its per-transaction log (-l) is
 * the client-side commit log; per-client counts there are compared with
 * per-client row counts in the table (lib/pgbench.ts explains why per client).
 * What pgbench does when its connection dies is part of the result: without
 * retry logic a client that loses its connection aborts, so the number of
 * clients still completing transactions after the fault is recorded next to
 * the loss count.
 *
 *   a  one 70 s pgbench, simple protocol
 *   b  one 70 s pgbench, `-M prepared`
 *   c  relaunch loop: back-to-back `pgbench -T 2` invocations for 45 s, so the
 *      load survives the failover and a stall can be read from the log. The
 *      stall then includes pgbench's own start-up and the loop's granularity.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  recreate,
  waitHealthy,
} from "../lib/cluster";
import { analysePgbench, parsePgbenchLog } from "../lib/pgbench";
import { preflight, repsOf } from "../lib/preflight";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const CLIENTS = 8;
const DURATION_S = 70;
const LOOP_MS = 45_000;
const FAULT_AT_MS = 10_000;

type Mode = "simple" | "prepared" | "loop";

async function one(ctx: Ctx, id: string, mode: Mode, fresh: boolean): Promise<TestResult> {
  const title = `pgbench (${mode === "loop" ? "relaunch loop, simple" : `-M ${mode}`}) through the gateway, SIGKILL primary postgres`;
  const container = containerOf(ctx);
  const gw = gatewayOf(ctx, 1);
  const table = `mg_pgb_${id.toLowerCase()}`;
  const ev: string[] = [];
  if (fresh) {
    const r = await recreate(ctx, ctx.log);
    ev.push(`fresh cluster: ${r.ok ? "healthy" : "NOT healthy"} after ${r.ms} ms`);
  }
  const pre = await waitHealthy(container, 180_000, ctx.log);
  if (!pre.ok) return { id, title, status: "skip", detail: "cluster not healthy before the run" };

  const admin = await connect(gw.host, gw.port);
  await admin.query(`drop table if exists ${table}`);
  await admin.query(`create table ${table}(client_id int not null, seq bigserial, ts timestamptz not null default clock_timestamp())`);
  await admin.end();

  const dir = await mkdtemp(join(tmpdir(), "mg05-"));
  try {
    const script = join(dir, "w.sql");
    await writeFile(script, `INSERT INTO ${table}(client_id) VALUES (:client_id);\n`);
    const primary = primaryOf(await cells(container));
    if (!primary || primary.postmasterPid === null) return { id, title, status: "skip", detail: "no primary" };
    ev.push(`primary before: ${primary.cell} service ${primary.serviceId}`);

    const spawn = (prefix: string, seconds: number) =>
      Bun.spawn(
        [
          "pgbench", "-n", "-c", String(CLIENTS), "-j", "2", "-T", String(seconds), "-l",
          "--log-prefix", join(dir, prefix), "-M", mode === "prepared" ? "prepared" : "simple", "-f", script,
          "-h", gw.host, "-p", String(gw.port), "-U", "postgres", "postgres",
        ],
        { env: { ...process.env, PGPASSWORD: "postgres" }, stdout: "pipe", stderr: "pipe" },
      );

    const t0 = Date.now();
    let tFault = 0;
    let offsetMs = 0;
    const fault = async () => {
      offsetMs = await clockOffsetMs(container);
      tFault = Date.now();
      const k = await dexec(container, ["kill", "-9", String(primary.postmasterPid)]);
      ev.push(`kill -9 ${primary.postmasterPid} exit ${k.code}, docker exec ${Date.now() - tFault} ms (load started ${tFault - t0} ms earlier)`);
    };

    let exits: number[] = [];
    const stderrs: string[] = [];
    let summary: string[] = [];
    if (mode === "loop") {
      const faultP = Bun.sleep(FAULT_AT_MS).then(fault);
      let i = 0;
      while (Date.now() - t0 < LOOP_MS) {
        const p = spawn(`it${String(i++).padStart(3, "0")}`, 2);
        const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        const code = await p.exited;
        exits.push(code);
        if (code !== 0) await Bun.sleep(50);
        if (err.trim()) stderrs.push(err.trim().split("\n")[0]!.slice(0, 200));
      }
      await faultP;
      const nz = exits.filter((c) => c !== 0).length;
      ev.push(`${exits.length} pgbench invocations, ${nz} exited non-zero; first stderr lines: ${[...new Set(stderrs)].slice(0, 4).join(" | ") || "(none)"}`);
    } else {
      const p = spawn("pgl", DURATION_S);
      const outP = new Response(p.stdout).text();
      const errP = new Response(p.stderr).text();
      await Bun.sleep(FAULT_AT_MS);
      await fault();
      exits = [await p.exited];
      const [out, err] = await Promise.all([outP, errP]);
      ev.push(`pgbench exit code ${exits[0]}`);
      ev.push(`pgbench stderr: ${err.trim().split("\n").slice(0, 12).join(" | ").slice(0, 900) || "(empty)"}`);
      summary = out.split("\n").filter((l) => /transactions actually processed|failed transactions|tps =|latency average/.test(l));
      ev.push(`pgbench summary: ${summary.join(" | ")}`);
    }

    const post = await waitHealthy(container, 120_000, ctx.log);
    for (const pe of await promotionEvents(container, tFault, offsetMs)) {
      ev.push(`multiorch primary.promotion at fault +${pe.atMs} ms: ${pe.outcome} reason=${pe.reason} new_primary=${pe.newPrimary} ${pe.extra}`.trimEnd());
    }
    const tl = await orchTimeline(container, tFault, offsetMs);
    if (tl.length) ev.push(`multiorch leadership log since the fault:\n  ${tl.join("\n  ")}`);

    const logText = (
      await Promise.all((await readdir(dir)).filter((f) => /^(pgl|it)/.test(f)).map((f) => readFile(join(dir, f), "utf8")))
    ).join("\n");
    const lines = parsePgbenchLog(logText);

    const rd = await connect(gw.host, gw.port);
    const r = await rd.query<{ client_id: number; c: string }>(`select client_id, count(*) as c from ${table} group by 1`);
    await rd.end();
    const rows = new Map(r.rows.map((x) => [Number(x.client_id), Number(x.c)]));
    const a = analysePgbench(lines, rows, tFault);
    const totalRows = [...rows.values()].reduce((s, n) => s + n, 0);
    ev.push(`rows in table ${totalRows}, transactions logged ${a.acked}; healed to 1 primary + 2 standbys: ${post.ok}`);

    // With every client dead the "stall" is just the log's last two lines; say n/a rather than 1 ms.
    const stall = a.clientsAlive === 0 ? "n/a (no client survived)" : (a.stallMs ?? "n/a");
    return {
      id,
      title,
      status: a.lost === 0 ? "pass" : "fail",
      detail: `${a.acked} logged, ${a.lost} acknowledged-but-lost, ${a.clientsAlive} of ${CLIENTS} client slots completing >1 s after the fault; stall ${typeof stall === "number" ? `${Math.round(stall)} ms` : stall}`,
      measurements: {
        mode,
        clients: CLIENTS,
        pgbench_invocations: exits.length,
        pgbench_nonzero_exits: exits.filter((c) => c !== 0).length,
        logged_transactions: a.acked,
        rows_in_table: totalRows,
        acked_but_lost: a.lost,
        committed_unacked_rows: Math.max(0, totalRows - a.acked),
        client_slots_alive_after_fault: a.clientsAlive,
        ack_stall_ms: typeof stall === "number" ? Math.round(stall) : stall,
        log_ends_after_fault_ms: a.logEndsAfterFaultMs ?? "n/a",
        healed_to_1p2s: post.ok ? "yes" : "no",
      },
      evidence: ev.join("\n"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const mod: TestModule = {
  id: "MG05",
  title: "pgbench write load through the gateway while the primary's postgres is SIGKILLed",
  where: "local",
  requires: ["pgbench"],
  destructive: true,
  async run(ctx): Promise<TestResult[]> {
    const skip = await preflight(ctx, "MG05", "pgbench failover");
    if (skip) return [skip];
    const modes: Mode[] = ["simple", "prepared", "loop"];
    const out: TestResult[] = [];
    const n = Math.min(repsOf(ctx, 3), modes.length);
    for (let i = 0; i < n; i++) {
      out.push(await one(ctx, `MG05${String.fromCharCode(97 + i)}`, modes[i]!, i === 0));
    }
    return out;
  },
};
export default mod;
