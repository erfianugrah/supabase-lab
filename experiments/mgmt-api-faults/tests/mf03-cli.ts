/**
 * MF03 - what the supabase CLI does when the Management API misbehaves.
 *
 * The CLI is pointed at the fault proxy with a `--profile` file whose
 * `api_url` is the proxy (the profile mechanism is the CLI's own; nothing is
 * patched). Attempt counts come from the proxy log.
 *
 *   MF03a  `projects list` (GET) answered 500/502/503/504/429 on every
 *          attempt: attempts per invocation, wall ms, exit code.
 *   MF03b  the retry budget: 500 x5 then healthy vs 500 x6 then healthy.
 *   MF03c  non-GET verbs answered 500 before reaching upstream: POST
 *          (`projects create`) and DELETE (`projects delete`) attempts.
 *   MF03d  POST create where upstream CREATED the project and the proxy
 *          answered 500 to the CLI: attempts, exit code, and whether the
 *          project exists afterwards (an orphan). Destructive: creates one
 *          project, swept in `finally`.
 *   MF03e  GET held 100 s by the proxy: does the CLI give up on its own.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { attempts, dbPassword, listPrefixed, missingTool, NAME_PREFIX, runCmd, scratchDir, scrub, sweep, waitGone, withProxy } from "../lib/proxy.js";

const LIST = /^\/v1\/projects$/;

const mod: TestModule = {
  id: "MF03",
  title: "supabase CLI under injected 5xx, 429 and latency",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = await missingTool(["docker", "supabase"]);
    if (missing) return [{ id: "MF03", title: this.title, status: "skip", detail: missing }];
    const results: TestResult[] = [];
    const dir = scratchDir("cli");
    try {
      await withProxy(async (px) => {
        const profile = join(dir, "profile.yaml");
        writeFileSync(
          profile,
          `name: mf\napi_url: ${px.url}\ndashboard_url: ${px.url}\ndocs_url: ${px.url}\nproject_host: supabase.co\n`,
        );
        const cli = (args: string[], timeoutMs = 120_000) =>
          runCmd(["supabase", "--profile", profile, "--workdir", dir, ...args], {
            cwd: dir,
            env: { SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" },
            timeoutMs,
          });

        // ---- MF03a: persistent faults on GET ----
        const m: Record<string, number | string> = {};
        const lines: string[] = [];
        const cases: Array<{ label: string; status: number; headers?: Record<string, string> }> = [
          { label: "500", status: 500 },
          { label: "502", status: 502 },
          { label: "503", status: 503 },
          { label: "504", status: 504 },
          { label: "429_retry_after_1", status: 429, headers: { "retry-after": "1" } },
          { label: "429_no_header", status: 429 },
        ];
        for (const c of cases) {
          await px.reset();
          await px.setRules([{ id: c.label, method: "GET", path: "^/v1/projects$", mode: "error-before", status: c.status, headers: c.headers }]);
          const r = await cli(["projects", "list"]);
          const lg = await px.log();
          const n = attempts(lg, "GET", LIST).length;
          const span = lg.length > 1 ? lg[lg.length - 1]!.t - lg[0]!.t : 0;
          m[`${c.label}_attempts`] = n;
          m[`${c.label}_ms`] = r.ms;
          m[`${c.label}_exit`] = r.code ?? -1;
          m[`${c.label}_first_to_last_attempt_ms`] = span;
          lines.push(`${c.label}: ${n} attempts, exit ${r.code}, ${r.ms} ms, first-to-last attempt ${span} ms`);
        }
        results.push({
          id: "MF03a",
          title: "MF03a: CLI GET on persistent 4xx/5xx - attempts per invocation",
          status: "info",
          detail: lines.join("; "),
          measurements: m,
        });

        // ---- MF03b: retry budget ----
        const mb: Record<string, number | string> = {};
        const lb: string[] = [];
        for (const k of [5, 6]) {
          await px.reset();
          await px.setRules([{ id: `x${k}`, method: "GET", path: "^/v1/projects$", mode: "error-before", status: 500, times: k }]);
          const r = await cli(["projects", "list"]);
          const n = attempts(await px.log(), "GET", LIST).length;
          mb[`fault_x${k}_attempts`] = n;
          mb[`fault_x${k}_exit`] = r.code ?? -1;
          lb.push(`500 x${k} then healthy: ${n} attempts, exit ${r.code}`);
        }
        results.push({
          id: "MF03b",
          title: "MF03b: CLI retry budget on GET (500 x5 vs x6 then healthy)",
          status: "info",
          detail: lb.join("; "),
          measurements: mb,
        });

        // ---- MF03c: non-GET verbs, error before upstream ----
        // The fake ref is never created; every request is answered by the proxy.
        const FAKE = "abcdefghijklmnopqrst";
        const verbs: Array<{ label: string; method: string; path: string; args: string[] }> = [
          { label: "POST_projects_create", method: "POST", path: "^/v1/projects$", args: ["projects", "create", `${NAME_PREFIX}cli-c`, "--org-id", org, "--db-password", dbPassword(), "--region", "ap-southeast-1", "--yes"] },
          { label: "POST_secrets_set", method: "POST", path: `^/v1/projects/${FAKE}/secrets$`, args: ["secrets", "set", "MF=1", "--project-ref", FAKE] },
          { label: "PUT_ssl_enforcement", method: "PUT", path: `^/v1/projects/${FAKE}/ssl-enforcement$`, args: ["ssl-enforcement", "update", "--enable-db-ssl-enforcement", "--project-ref", FAKE, "--experimental"] },
          { label: "DELETE_projects_delete", method: "DELETE", path: `^/v1/projects/${FAKE}$`, args: ["projects", "delete", FAKE, "--yes"] },
          { label: "DELETE_domains_delete", method: "DELETE", path: `^/v1/projects/${FAKE}/custom-hostname$`, args: ["domains", "delete", "--project-ref", FAKE] },
        ];
        const mc: Record<string, number | string> = {};
        const lc: string[] = [];
        for (const v of verbs) {
          await px.reset();
          await px.setRules([{ id: v.label, method: v.method, path: v.path, mode: "error-before", status: 500 }]);
          const r = await cli(v.args);
          const n = attempts(await px.log(), v.method, new RegExp(v.path)).length;
          mc[`${v.label}_attempts`] = n;
          mc[`${v.label}_exit`] = r.code ?? -1;
          lc.push(`${v.method} (${v.label.split("_").slice(1).join(" ")}): ${n} attempt(s), exit ${r.code}`);
        }
        // POST through the other retryable statuses, on the cheapest POST.
        for (const status of [502, 503, 504, 429]) {
          await px.reset();
          await px.setRules([{ id: `post${status}`, method: "POST", path: `^/v1/projects/${FAKE}/secrets$`, mode: "error-before", status, headers: status === 429 ? { "retry-after": "1" } : undefined }]);
          await cli(["secrets", "set", "MF=1", "--project-ref", FAKE]);
          const n = attempts(await px.log(), "POST", new RegExp(`/secrets$`)).length;
          mc[`POST_secrets_set_${status}_attempts`] = n;
          lc.push(`POST secrets set answered ${status}: ${n} attempt(s)`);
        }
        results.push({
          id: "MF03c",
          title: "MF03c: CLI non-GET verbs on a 500 (and POST on 502/503/504/429) - attempts",
          status: "info",
          detail: lc.join("; "),
          measurements: mc,
        });

        // ---- MF03d: POST that succeeded upstream, 500 to the CLI ----
        await px.reset();
        const name = `${NAME_PREFIX}cli-d-${Date.now()}`;
        await px.setRules([{ id: "post-after", method: "POST", path: "^/v1/projects$", mode: "error-after", status: 500, times: 1 }]);
        const cd = await cli(["projects", "create", name, "--org-id", org, "--db-password", dbPassword(), "--region", "ap-southeast-1", "--yes"]);
        const ld = await px.log();
        const posts = ld.filter((r) => r.method === "POST");
        await Bun.sleep(5000);
        const orphans = (await listPrefixed(ctx)).filter((p) => p.name === name);
        results.push({
          id: "MF03d",
          title: "MF03d: CLI create answered 500 after upstream created the project",
          status: orphans.length > 0 ? "info" : "fail",
          detail: `${posts.length} POST attempt(s), CLI exit ${cd.code}; projects named like the request afterwards: ${orphans.length}`,
          measurements: { post_attempts: posts.length, cli_exit: cd.code ?? -1, upstream_status: posts[0]?.upstreamStatus ?? -1, orphans: orphans.length },
          evidence: scrub(`${cd.stdout.slice(0, 300)} ${cd.stderr.slice(0, 200)}`),
        });
        await sweep(ctx, (n) => n === name);
        await waitGone(ctx, (n) => n === name);

        // ---- MF03e: latency ----
        await px.reset();
        await px.setRules([{ id: "hold100", method: "GET", path: "^/v1/projects$", mode: "delay-before", delayMs: 100_000 }]);
        const ce = await cli(["projects", "list"], 420_000);
        const le = attempts(await px.log(), "GET", LIST);
        const nE = le.length;
        const offsets = le.map((r) => Math.round((r.t - le[0]!.t) / 1000));
        results.push({
          id: "MF03e",
          title: "MF03e: CLI GET held 100 s by the proxy",
          status: "info",
          detail: `exit ${ce.code}${ce.timedOut ? " (killed at 420 s deadline)" : ""} after ${ce.ms} ms; ${nE} attempt(s)`,
          measurements: { ms: ce.ms, exit: ce.code ?? -1, attempts: nE, second_attempt_offset_s: offsets[1] ?? -1, killed_by_harness: ce.timedOut ? 1 : 0 },
          evidence: scrub(`attempt start offsets (s): ${offsets.join(",")}\n${ce.stdout.slice(0, 200)} ${ce.stderr.slice(0, 200)}`),
        });
      });
    } catch (e) {
      results.push({ id: "MF03", title: "MF03", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await sweep(ctx).catch(() => 0);
    }
    return results;
  },
};
export default mod;
