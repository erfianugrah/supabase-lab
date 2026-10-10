/**
 * PC03 - what a driver's pool does when the TCP connection to Supavisor is
 * reset: node-postgres (pg 8.13.1), postgres.js (3.4.5), Prisma 6.19.3.
 *
 * A toxiproxy container (IMAGE below, tag checked against the registry) sits
 * between the client process and the Supavisor transaction pooler (6543)
 * of the throwaway project. Each run: a fresh node process opens a
 * 5-connection pool and warms it, then 5 workers issue `select 1` every
 * 200 ms. 4 s after the pool is warm the module injects a fault for 2 s and
 * clears it; the run ends 22 s after warm-up. A failed statement is retried
 * once after RETRY_DELAY_MS (300 ms by default) and both outcomes are logged, so one run reports what the
 * application sees without retry and with retry-once.
 *
 * Faults:
 *   reset  toxiproxy `reset_peer` on both streams (timeout 0): the next bytes
 *          on any connection, old or new, get a TCP RST for 2 s.
 *   cut    proxy disabled then enabled (2 s): established connections are
 *          closed at once, new connects are refused until it is back.
 *
 * Rows (3 runs per cell, `a/b/c` = run 1/2/3):
 *   PC03-control-<driver>   no fault, 10 s: the proxy adds no errors
 *   PC03-<driver>-<fault>
 *   flap   (150 ms) proxy disabled and re-enabled: every established connection
 *          dies, new connects work immediately - the symptom of a node being
 *          replaced behind a healthy address. Counts stale-connection hand-outs.
 *   PC03-pg-noerr-cut       node-postgres WITHOUT a pool 'error' listener
 *
 * Counted by attempt START time: "in window" = fault on..off, "after clear" =
 * started after the fault was removed. A failure after clear is a pool that
 * handed out a dead or stale connection once the network was healthy again.
 * Not settled: a real Supavisor node replacement (the proxy models the TCP
 * symptom, not the platform event), other driver versions, Bun/Deno runtimes,
 * long-idle pools, prepared statements.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { acquireProject, sleep, stallGuard } from "../lib/project";
import { parseLines, summarise, type RunSummary } from "../lib/summary";

const DIR = process.env.PVLAB_PC_DRIVERS_DIR ?? resolve(process.cwd(), "drivers");
const CONTAINER = process.env.PVLAB_PC_TOXI_NAME ?? "pc-toxiproxy";
const IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
const API = "http://127.0.0.1:18474";
const LISTEN_PORT = 16543;
const FAULT_AT_MS = 4000;
const FAULT_MS = 2000;
const RUN_MS = 22_000;
const RUNS = 3;
// Delay before the probe's single retry; PVLAB_PC_RETRY_DELAY_MS=0 is retry-immediately.
const RETRY_DELAY_MS = process.env.PVLAB_PC_RETRY_DELAY_MS ?? "300";

type Fault = "reset" | "cut" | "flap" | "none";
/** flap = proxy disabled and re-enabled within FLAP_MS: established connections die, new connects succeed at once. */
const FLAP_MS = 150;
const faultMs = (f: Fault) => (f === "flap" ? FLAP_MS : FAULT_MS);

async function toxi(method: string, path: string, body?: unknown): Promise<number> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.status;
}

async function inject(fault: Fault): Promise<void> {
  if (fault === "reset") {
    for (const stream of ["upstream", "downstream"])
      await toxi("POST", "/proxies/pooler/toxics", { name: `reset_${stream}`, type: "reset_peer", stream, toxicity: 1, attributes: { timeout: 0 } });
  } else if (fault === "cut" || fault === "flap") {
    await toxi("POST", "/proxies/pooler", { enabled: false });
  }
}
async function clear(fault: Fault): Promise<void> {
  if (fault === "reset") {
    for (const stream of ["upstream", "downstream"]) await toxi("DELETE", `/proxies/pooler/toxics/reset_${stream}`);
  } else if (fault === "cut" || fault === "flap") {
    await toxi("POST", "/proxies/pooler", { enabled: true });
  }
}

interface RunOut {
  s: RunSummary;
  exitCode: number;
  crashed: boolean;
  poolErrors: number;
  stderrTail: string;
  stderrHead: string;
  faultOn: number;
  faultOff: number;
}

async function oneRun(driver: string, url: string, fault: Fault, durationMs: number): Promise<RunOut> {
  const proc = Bun.spawn(["node", "probe.mjs"], {
    cwd: DIR,
    env: { ...process.env, DRIVER: driver, PROXY_URL: url, DURATION_MS: String(durationMs), CONC: "5", INTERVAL_MS: "200", RETRY_DELAY_MS },
    stdout: "pipe",
    stderr: "pipe",
  });
  let buf = "";
  let readyAt = 0;
  const reader = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk);
      if (!readyAt && buf.includes('"e":"ready"')) readyAt = Date.now();
    }
  })();
  const errText = new Response(proc.stderr).text();

  const waitStart = Date.now();
  while (!readyAt && Date.now() - waitStart < 40_000 && proc.exitCode === null) await sleep(50);
  const base = readyAt || Date.now();
  let faultOn = base + FAULT_AT_MS;
  let faultOff = faultOn + faultMs(fault);
  if (readyAt && fault !== "none") {
    await sleep(Math.max(0, FAULT_AT_MS - (Date.now() - readyAt)));
    faultOn = Date.now();
    await inject(fault);
    await sleep(faultMs(fault));
    faultOff = Date.now();
    await clear(fault);
  }
  const killer = setTimeout(() => proc.kill(), durationMs + 30_000);
  const exitCode = await proc.exited;
  clearTimeout(killer);
  await reader;
  const stderr = await errText;
  const { events, other } = parseLines(buf);
  const hasDone = other.some((o) => o.e === "done");
  return {
    s: summarise(events, faultOn, faultOff),
    exitCode,
    crashed: exitCode !== 0 && !hasDone,
    poolErrors: other.filter((o) => o.e === "pool_error").length,
    stderrTail: stderr.replace(/\s+/g, " ").slice(-240),
    stderrHead: stderr.replace(/\s+/g, " ").slice(0, 200),
    faultOn,
    faultOff,
  };
}

const join = (xs: (number | null)[]) => xs.map((x) => (x === null ? "none" : String(x))).join("/");

async function ensureToxiproxy(ctx: Ctx): Promise<{ started: boolean; error?: string }> {
  const running = (await $`docker ps --filter name=^${CONTAINER}$ --format {{.Names}}`.quiet().nothrow().text()).trim();
  if (running === CONTAINER) return { started: false };
  const r = await $`docker run -d --rm --name ${CONTAINER} -p 127.0.0.1:18474:8474 -p 127.0.0.1:${LISTEN_PORT}:${LISTEN_PORT} ${IMAGE}`.quiet().nothrow();
  if (r.exitCode !== 0) return { started: false, error: r.stderr.toString().slice(-200) };
  ctx.log(`toxiproxy container ${CONTAINER} started`);
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${API}/version`)).ok) return { started: true };
    } catch {}
    await sleep(250);
  }
  return { started: true, error: "toxiproxy API did not answer" };
}

const mod: TestModule = {
  id: "PC03",
  title: "TCP reset between client and Supavisor: node-postgres, postgres.js, Prisma pool eviction and retry",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "PC03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    const guard = stallGuard("PC03");
    const p = await acquireProject(ctx);

    const tox = await ensureToxiproxy(ctx);
    if (tox.error) {
      if (tox.started) await $`docker stop ${CONTAINER}`.quiet().nothrow();
      return [{ id: "PC03", title: "PC03", status: "skip", detail: `toxiproxy unavailable: ${tox.error}` }];
    }
    try {
      if (!existsSync(resolve(DIR, "node_modules/.bin/prisma"))) {
        const i = await $`bun install`.cwd(DIR).quiet().nothrow();
        if (i.exitCode !== 0) return [{ id: "PC03", title: "PC03", status: "fail", detail: `bun install in drivers/ failed: ${i.stderr.toString().slice(-300)}` }];
      }
      const gen = await $`bunx prisma generate --schema schema.prisma`.cwd(DIR).env({ ...process.env, DATABASE_URL: "postgres://x:y@127.0.0.1:1/postgres" }).quiet().nothrow();
      if (gen.exitCode !== 0) return [{ id: "PC03", title: "PC03", status: "fail", detail: `prisma generate failed: ${gen.stderr.toString().slice(-300)}` }];
      const ver = (await $`node --version`.quiet().text()).trim();

      await toxi("DELETE", "/proxies/pooler");
      const created = await toxi("POST", "/proxies", { name: "pooler", listen: `0.0.0.0:${LISTEN_PORT}`, upstream: `${p.poolerHost}:6543`, enabled: true });
      if (created !== 201) return [{ id: "PC03", title: "PC03", status: "fail", detail: `proxy create HTTP ${created}` }];

      const base = `postgres://${encodeURIComponent(p.poolerUser)}:${encodeURIComponent(p.password)}@127.0.0.1:${LISTEN_PORT}/postgres`;
      const urlFor = (driver: string) =>
        driver === "prisma" ? `${base}?sslmode=require&sslaccept=accept_invalid_certs&pgbouncer=true&connection_limit=5&pool_timeout=10` : base;

      // ---- control: no fault
      for (const driver of ["pg", "postgresjs", "prisma"]) {
        const r = await oneRun(driver, urlFor(driver), "none", 10_000);
        out.push({
          id: `PC03-control-${driver}`,
          title: `PC03 control: ${driver} through the proxy, no fault, 10 s`,
          status: r.s.failed_total === 0 && !r.crashed && r.s.attempts > 0 ? "pass" : "fail",
          detail: `${r.s.attempts} statements, ${r.s.failed_total} failed, exit ${r.exitCode}${r.crashed ? ` (${r.stderrTail})` : ""}`,
          measurements: { driver, node: ver, attempts: r.s.attempts, failed: r.s.failed_total, max_ms: r.s.max_ms },
        });
      }

      // ---- fault matrix
      const cells: [string, string, Fault][] = [
        ["pg", "pg", "reset"],
        ["pg", "pg", "cut"],
        ["pg-noerr", "pg-nohandler", "cut"],
        ["postgresjs", "postgresjs", "reset"],
        ["postgresjs", "postgresjs", "cut"],
        ["prisma", "prisma", "reset"],
        ["prisma", "prisma", "cut"],
        ["pg", "pg", "flap"],
        ["postgresjs", "postgresjs", "flap"],
        ["prisma", "prisma", "flap"],
      ];
      for (const [label, driver, fault] of cells) {
        const runs: RunOut[] = [];
        for (let k = 0; k < RUNS; k++) {
          runs.push(await oneRun(driver, urlFor(driver), fault, RUN_MS));
          await sleep(1500);
        }
        const errs = new Map<string, number>();
        for (const r of runs) for (const [k, n] of Object.entries(r.s.errors)) errs.set(k, (errs.get(k) ?? 0) + n);
        const topErrs = [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n}x ${k}`).join(" | ");
        const crashes = runs.filter((r) => r.crashed).length;
        const afterClear = runs.map((r) => r.s.failed_after_clear);
        out.push({
          id: `PC03-${label}-${fault}`,
          title: `PC03 ${label} (${driver}), ${fault} for ${faultMs(fault)} ms, ${RUNS} runs`,
          status: "info",
          detail:
            `failed in window ${join(runs.map((r) => r.s.failed_in_window))}, failed after clear ${join(afterClear)}, ` +
            `retry-once rescued ${join(runs.map((r) => r.s.retry_rescued))} of failed ${join(runs.map((r) => r.s.failed_total))}, ` +
            `crashed ${crashes} of ${RUNS}; top errors: ${topErrs || "none"}`,
          measurements: {
            driver,
            fault,
            runs: RUNS,
            attempts: join(runs.map((r) => r.s.attempts)),
            failed_total: join(runs.map((r) => r.s.failed_total)),
            failed_in_window: join(runs.map((r) => r.s.failed_in_window)),
            failed_after_clear: join(afterClear),
            first_fail_after_fault_ms: join(runs.map((r) => r.s.first_fail_after_fault_ms)),
            last_fail_after_clear_ms: join(runs.map((r) => r.s.last_fail_after_clear_ms)),
            first_ok_after_clear_ms: join(runs.map((r) => r.s.first_ok_after_clear_ms)),
            retry_rescued: join(runs.map((r) => r.s.retry_rescued)),
            retry_failed: join(runs.map((r) => r.s.retry_failed)),
            app_timeouts: join(runs.map((r) => r.s.app_timeouts)),
            max_ms: join(runs.map((r) => r.s.max_ms)),
            pool_error_events: join(runs.map((r) => r.poolErrors)),
            crashed_runs: crashes,
            exit_codes: runs.map((r) => r.exitCode).join("/"),
            top_errors: topErrs || "none",
            stderr_head_if_crashed: runs.find((r) => r.crashed)?.stderrHead ?? "n/a",
            stderr_tail_if_crashed: runs.find((r) => r.crashed)?.stderrTail ?? "n/a",
          },
          evidence: JSON.stringify(runs.map((r) => ({ ...r.s, exit: r.exitCode, crashed: r.crashed, pool_errors: r.poolErrors })), null, 1),
        });
      }
      out.push(guard.result());
      return out;
    } finally {
      await toxi("DELETE", "/proxies/pooler").catch(() => 0);
      if (tox.started) await $`docker stop ${CONTAINER}`.quiet().nothrow();
    }
  },
};

export default mod;
