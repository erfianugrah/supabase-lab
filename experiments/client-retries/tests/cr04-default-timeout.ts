/**
 * CR04 - does supabase-js time out at all by default?
 *
 * supabase-js has no timeout unless `db.timeout` or an AbortSignal is passed
 * (CR01d1-d2 measured 3 s and 10 s delays completing normally). Whether a
 * request that is NEVER answered ever fails is then a property of the runtime's
 * fetch, so this module holds a request open for `PVLAB_CR_HANG_MS` (default
 * 330 s, chosen to be longer than 300 s, the undici headers timeout as recalled
 * from memory and not verified here) and records
 * what a default supabase-js client does under Bun and under Node.
 *
 * Local mock, no project. Opt-in because it takes over five minutes:
 * `PVLAB_CR_LONG=1`.
 */
import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const PROBE = join(import.meta.dir, "..", "lib", "hang-probe.ts");

async function exec(cmd: string[], timeoutMs: number): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    return out.trim().split("\n").at(-1) || `no output: ${err.slice(0, 200)}`;
  } catch (e) {
    return `spawn failed: ${(e as Error).message.slice(0, 200)}`;
  }
}

async function onPath(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([cmd, "--version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const mod: TestModule = {
  id: "CR04",
  title: "default supabase-js behaviour when a request is never answered",
  where: "local",
  requires: [],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (process.env.PVLAB_CR_LONG !== "1") {
      return [{ id: "CR04", title: "CR04: long hang", status: "skip", detail: "opt-in: set PVLAB_CR_LONG=1 (takes over 5 minutes)" }];
    }
    const runtimes = ["bun"];
    if (await onPath("node")) runtimes.push("node");
    else ctx.log("node not on PATH: the Node probe is skipped");
    if (!(await onPath("bun"))) {
      return [{ id: "CR04", title: "CR04: long hang", status: "skip", detail: "bun not runnable as a child process" }];
    }
    const maxMs = Number(process.env.PVLAB_CR_HANG_MS ?? 330_000);
    let accepted = 0;
    const closedAfter: number[] = [];
    const server = createServer((req) => {
      accepted++;
      const t = Date.now();
      req.resume();
      req.socket.on("close", () => closedAfter.push(Date.now() - t));
      // never answered
    });
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const outs = await Promise.all(runtimes.map((rt) => exec([rt, PROBE, url, String(maxMs)], maxMs + 60_000)));
      const results: TestResult[] = [];
      for (const line of outs) {
        let j: { runtime?: string; settled?: boolean; status?: number; error?: string; elapsedMs?: number } = {};
        try {
          j = JSON.parse(line);
        } catch {
          results.push({ id: "CR04-parse", title: "CR04: probe output", status: "fail", detail: line });
          continue;
        }
        const rt = (j.runtime ?? "?").split(" ")[0];
        results.push({
          id: `CR04-${rt}`,
          title: `CR04 ${j.runtime}: default client, request never answered for up to ${maxMs} ms`,
          status: "info",
          detail: j.settled ? `failed after ${j.elapsedMs} ms: ${j.error}` : `still pending at ${j.elapsedMs} ms`,
          measurements: { runtime: j.runtime ?? "?", max_ms: maxMs, settled: j.settled ? 1 : 0, elapsed_ms: j.elapsedMs ?? -1, error: j.error || "-" },
        });
      }
      results.push({ id: "CR04-server", title: "CR04: mock server view", status: "info", measurements: { requests_accepted: accepted, socket_closed_after_ms: closedAfter.join(",") || "-" } });
      return results;
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
};

export default mod;
