/**
 * CR03 - the retry policy per supabase-js version and per JS runtime, against a
 * local mock (no project, no cost).
 *
 * The public changelog says retries arrived in supabase-js 2.102.0 and names
 * the JS opt-out `retryEnabled: false`. This module installs several versions
 * into temp dirs, runs `lib/version-probe.ts` under Bun and under Node, and
 * records for each: attempts and X-Retry-Count on a 503, a 525, a connection
 * reset, a POST, and each opt-out spelling.
 *
 * Needs the npm registry and (for the Node column) `node` on PATH. A version
 * that fails to install is recorded, not retried.
 */
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const VERSIONS = (process.env.PVLAB_CR_VERSIONS ?? "2.101.1,2.102.0,2.103.3,2.104.0,2.105.0,2.106.0,2.107.0,2.108.0,2.109.0,2.110.0,2.111.0,2.112.0,2.112.3,2.117.3").split(",").map((s) => s.trim()).filter(Boolean);
const PROBE = join(import.meta.dir, "..", "lib", "version-probe.ts");

interface CaseRow {
  name: string;
  attempts: number;
  wire: number;
  rc: string;
  elapsedMs: number;
  status: number;
  code: string;
}
interface ProbeOut {
  version: string;
  runtime: string;
  hasRetryMethod: boolean;
  cases: Record<string, CaseRow>;
}

async function exec(cmd: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err };
}

async function probeVersion(version: string, runtimes: string[]): Promise<{ version: string; error?: string; outs: Record<string, ProbeOut | string> }> {
  const dir = await mkdtemp(join(tmpdir(), `cr03-${version}-`));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "cr03", private: true, type: "module" }));
    const add = await exec(["bun", "add", `@supabase/supabase-js@${version}`], dir, 120_000).catch((e: Error) => ({ code: 1, out: "", err: `spawn failed: ${e.message}` }));
    if (add.code !== 0) return { version, error: `bun add failed: ${add.err.slice(0, 200)}`, outs: {} };
    await copyFile(PROBE, join(dir, "probe.ts"));
    const outs: Record<string, ProbeOut | string> = {};
    await Promise.all(
      runtimes.map(async (rt) => {
        const r = await exec([rt, "probe.ts"], dir, 90_000);
        const line = r.out.trim().split("\n").at(-1) ?? "";
        try {
          outs[rt] = JSON.parse(line) as ProbeOut;
        } catch {
          outs[rt] = `no JSON (exit ${r.code}): ${(r.err || r.out).slice(0, 200)}`;
        }
      }),
    );
    return { version, outs };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => null);
  }
}

const mod: TestModule = {
  id: "CR03",
  title: "supabase-js retry policy per version and runtime (local mock)",
  where: "local",
  requires: [],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const runtimes = ["bun"];
    const nodeOk = (await exec(["node", "--version"], tmpdir(), 10_000).catch(() => ({ code: 1, out: "", err: "" }))).code === 0;
    if (nodeOk) runtimes.push("node");
    else ctx.log("node not on PATH: the Node column is skipped");

    const all = await Promise.all(VERSIONS.map((v) => probeVersion(v, runtimes)));
    if (all.every((v) => v.error)) {
      return [{ id: "CR03", title: "CR03: version matrix", status: "skip", detail: `every install failed, so the npm registry is taken to be unreachable; first error: ${all[0]?.error ?? "-"}` }];
    }
    const results: TestResult[] = [];
    for (const v of all) {
      if (v.error) {
        results.push({ id: `CR03-${v.version}`, title: `CR03 ${v.version}`, status: "fail", detail: v.error });
        continue;
      }
      for (const rt of runtimes) {
        const o = v.outs[rt];
        const id = `CR03-${v.version}-${rt}`;
        if (typeof o === "string" || !o) {
          results.push({ id, title: id, status: "fail", detail: String(o) });
          continue;
        }
        const m: Record<string, number | string> = { runtime: o.runtime, retry_method: o.hasRetryMethod ? 1 : 0 };
        for (const c of Object.values(o.cases)) {
          m[`${c.name}_attempts`] = c.attempts;
          m[`${c.name}_wire`] = c.wire;
          m[`${c.name}_rc`] = c.rc;
          m[`${c.name}_ms`] = c.elapsedMs;
        }
        results.push({
          id,
          title: `CR03 supabase-js ${o.version} on ${o.runtime}`,
          status: "info",
          detail: `503 GET attempts=${o.cases.get_503?.attempts} 525 GET=${o.cases.get_525?.attempts} POST 503=${o.cases.post_503?.attempts} db.retry=false=${o.cases.get_503_db_retry_false?.attempts} db.retryEnabled=false=${o.cases.get_503_db_retryEnabled_false?.attempts} abortSignal.timeout(2500): ${o.cases.get_503_abort_timeout_2500?.attempts} attempts ${o.cases.get_503_abort_timeout_2500?.elapsedMs} ms`,
          measurements: m,
        });
      }
    }
    return results;
  },
};

export default mod;
