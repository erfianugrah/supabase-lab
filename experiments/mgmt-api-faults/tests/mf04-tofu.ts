/**
 * MF04 - the OpenTofu supabase provider (pinned in tf/.terraform.lock.hcl)
 * under injected faults. One scratch working directory with LOCAL state, one
 * config (tf/main.tf: a project, optionally its settings), the provider's
 * `endpoint` pointed at the fault proxy. Each step runs `tofu` once, then
 * records: exit code, wall ms, attempts at the wire (proxy log), resources in
 * state, and what the Management API holds, read directly (not via the proxy).
 *
 *   MF04a  POST /v1/projects answered 500 before upstream, once: does the
 *          provider retry the create.
 *   MF04b  POST /v1/projects answered 500 AFTER upstream created the project:
 *          the apply fails; is anything in state; does the project exist.
 *   MF04c  plain re-apply with the orphan from MF04b still there, then again
 *          after the orphan is deleted: what the "just run apply again"
 *          recovery does.
 *   MF04d  settings writes: 500 before upstream (once), then 500 after
 *          upstream applied (once); state vs upstream value, and whether a
 *          later plan converges.
 *   MF04e  reads during plan/refresh: 500 once, 503 always, 429 with
 *          Retry-After once, and a 100 s hold: attempts and exit codes.
 *   MF04f  destroy: DELETE answered 500 before upstream, then 500 after
 *          upstream deleted, then a clean destroy against the leftover state.
 *
 * Creates one mf- project in the common path (more when a step
 * leaves an orphan); every one is deleted in `finally`.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  attempts, dbPassword, listPrefixed, missingTool, NAME_PREFIX, runCmd, scratchDir, scrub, shape, sweep, waitGone, withProxy,
  type Proxy, type Rule,
} from "../lib/proxy.js";

const TF_SRC = resolve(import.meta.dir, "../tf");
const PROJECTS = /^\/v1\/projects$/;
const PROJECT = /^\/v1\/projects\/[a-z]{20}$/;
const WRITE_ROUTES = "^/v1/projects/[a-z]{20}/(?!health|api-keys)";

function errLines(s: string): string {
  const out: string[] = [];
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/Error:/.test(lines[i]!)) out.push(...lines.slice(i, i + 4).map((l) => l.trim()).filter(Boolean));
  }
  return scrub(out.join(" | ")).slice(0, 500);
}

const mod: TestModule = {
  id: "MF04",
  title: "OpenTofu supabase provider under injected 5xx, 429 and latency",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF04", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = await missingTool(["docker", "tofu"]);
    if (missing) return [{ id: "MF04", title: this.title, status: "skip", detail: missing }];
    const results: TestResult[] = [];
    const dir = scratchDir("tofu");
    const name = `${NAME_PREFIX}tf-${Date.now()}`;
    const direct = { ...ctx, mgmtBase: "https://api.supabase.com/v1" } as Ctx;
    const pw = dbPassword();
    let px: Proxy | undefined;

    const tofu = async (args: string[], vars: Record<string, string> = {}, timeoutMs = 900_000) =>
      runCmd(["tofu", `-chdir=${dir}`, ...args], {
        env: {
          TF_IN_AUTOMATION: "1",
          TF_INPUT: "0",
          TF_VAR_endpoint: px!.url,
          TF_VAR_access_token: ctx.pat ?? "",
          TF_VAR_org_id: org,
          TF_VAR_project_name: name,
          TF_VAR_db_password: pw,
          ...vars,
        },
        timeoutMs,
      });
    const stateList = async () => {
      const r = await tofu(["state", "list", "-no-color"]);
      return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
    };
    const named = async () => (await listPrefixed(ctx)).filter((p) => p.name === name);
    const apply = (vars: Record<string, string> = {}) => tofu(["apply", "-auto-approve", "-no-color"], vars);
    const arm = async (rules: Rule[]) => {
      await px!.reset();
      await px!.setRules(rules);
    };
    const resetUpstream = async () => {
      await tofu(["destroy", "-auto-approve", "-no-color"]);
      await sweep(ctx, (n) => n === name);
      await waitGone(ctx, (n) => n === name);
    };

    try {
      copyFileSync(join(TF_SRC, "main.tf"), join(dir, "main.tf"));
      copyFileSync(join(TF_SRC, ".terraform.lock.hcl"), join(dir, ".terraform.lock.hcl"));
      await withProxy(async (p) => {
        px = p;
        const init = await runCmd(["tofu", `-chdir=${dir}`, "init", "-no-color", "-input=false"], { timeoutMs: 180_000 });
        if (init.code !== 0) {
          results.push({ id: "MF04", title: "MF04 init", status: "fail", detail: `tofu init exit ${init.code}: ${scrub(init.stderr).slice(0, 300)}` });
          return;
        }

        // ---- MF04a: transient 500 on create, before upstream ----
        await arm([{ id: "post500", method: "POST", path: "^/v1/projects$", mode: "error-before", status: 500, times: 1 }]);
        const a = await apply();
        const la = await px.log();
        const stA = await stateList();
        const upA = await named();
        results.push({
          id: "MF04a",
          title: "MF04a: provider create through one 500 (before upstream)",
          status: "info",
          detail: `apply exit ${a.code} in ${a.ms} ms; ${attempts(la, "POST", PROJECTS).length} POST attempt(s); state: ${stA.length} resource(s); projects with the name upstream: ${upA.length}`,
          measurements: { exit: a.code ?? -1, ms: a.ms, post_attempts: attempts(la, "POST", PROJECTS).length, state_resources: stA.length, upstream_projects: upA.length },
          evidence: `${errLines(a.stdout + a.stderr)}\n${shape(la)}`,
        });
        if (upA.length > 0 || stA.length > 0) await resetUpstream();

        // ---- MF04b: 500 after upstream created ----
        await arm([{ id: "post-after", method: "POST", path: "^/v1/projects$", mode: "error-after", status: 500, times: 1 }]);
        const b = await apply();
        const lb = await px.log();
        const stB = await stateList();
        const upB = await named();
        results.push({
          id: "MF04b",
          title: "MF04b: provider create answered 500 after upstream created the project",
          status: "info",
          detail: `apply exit ${b.code} in ${b.ms} ms; ${attempts(lb, "POST", PROJECTS).length} POST attempt(s); state: ${stB.length} resource(s); projects with the name upstream: ${upB.length}`,
          measurements: { exit: b.code ?? -1, ms: b.ms, post_attempts: attempts(lb, "POST", PROJECTS).length, state_resources: stB.length, upstream_projects: upB.length },
          evidence: `${errLines(b.stdout + b.stderr)}\n${shape(lb)}`,
        });

        // ---- MF04c: the re-apply recovery ----
        await arm([]);
        const c1 = await apply();
        const lc1 = await px.log();
        const stC1 = await stateList();
        const upC1 = await named();
        await sweep(ctx, (n) => n === name);
        await waitGone(ctx, (n) => n === name);
        await arm([]);
        const c2 = await apply();
        const stC2 = await stateList();
        const upC2 = await named();
        results.push({
          id: "MF04c",
          title: "MF04c: re-apply with the orphan present, then after deleting it",
          status: "info",
          detail:
            `with orphan: exit ${c1.code}, ${attempts(lc1, "POST", PROJECTS).length} POST attempt(s) answered ${attempts(lc1, "POST", PROJECTS)[0]?.upstreamStatus ?? "-"}, state ${stC1.length}, upstream ${upC1.length}; ` +
            `after deleting orphan: exit ${c2.code} in ${c2.ms} ms, state ${stC2.length}, upstream ${upC2.length}`,
          measurements: {
            orphan_exit: c1.code ?? -1,
            orphan_post_upstream_status: attempts(lc1, "POST", PROJECTS)[0]?.upstreamStatus ?? -1,
            orphan_state_resources: stC1.length,
            orphan_upstream_projects: upC1.length,
            clean_exit: c2.code ?? -1,
            clean_ms: c2.ms,
            clean_state_resources: stC2.length,
            clean_upstream_projects: upC2.length,
          },
          evidence: `${errLines(c1.stdout + c1.stderr)}`,
        });
        if (stC2.length === 0) return; // no project to carry the later steps

        // ---- MF04d: settings writes ----
        // MF04d0: the project is in state; the first settings create gets a 500
        // before upstream. A partial apply: project tracked, settings not.
        const writeRules = (mode: Rule["mode"], times: number): Rule[] =>
          ["PATCH", "PUT", "POST"].map((m) => ({ id: `w-${m}`, method: m, path: WRITE_ROUTES, mode, status: 500, times }));
        await arm(writeRules("error-before", 1));
        const d00 = await apply({ TF_VAR_enable_settings: "true", TF_VAR_max_rows: "1000" });
        const ld00 = await px.log();
        const st00 = await stateList();
        await arm([]);
        const p00 = await tofu(["plan", "-detailed-exitcode", "-no-color"], { TF_VAR_enable_settings: "true", TF_VAR_max_rows: "1000" });
        results.push({
          id: "MF04d0",
          title: "MF04d0: settings create answered 500 before upstream, once (project already in state)",
          status: "info",
          detail: `apply exit ${d00.code}; ${ld00.filter((r) => r.method !== "GET").length} write attempt(s); state after: ${st00.join(", ") || "empty"}; plan afterwards exit ${p00.code} (2 = settings still to create)`,
          measurements: { exit: d00.code ?? -1, write_attempts: ld00.filter((r) => r.method !== "GET").length, state_resources: st00.length, plan_exit_after: p00.code ?? -1 },
          evidence: `${errLines(d00.stdout + d00.stderr)}\n${shape(ld00)}`,
        });

        // Control: the same apply with no fault, to learn the write route and the upstream value.
        await arm([]);
        const d0 = await apply({ TF_VAR_enable_settings: "true", TF_VAR_max_rows: "1000" });
        const ld0 = await px.log();
        const writes0 = ld0.filter((r) => r.method !== "GET" && /^\/v1\/projects\/[a-z]{20}\//.test(r.path));
        const readPath = (writes0.find((r) => /postgrest/.test(r.path))?.path.replace(/\?.*$/, "") ?? "").replace(/^\/v1/, "");
        const upstreamRows = async (): Promise<number> => {
          if (!readPath) return -1;
          const r = await mgmt(direct, "GET", readPath);
          return Number((r.json as { max_rows?: number } | undefined)?.max_rows ?? -1);
        };
        const base0 = await upstreamRows();
        results.push({
          id: "MF04d0c",
          title: "MF04d0c: settings create with no fault (control) - write route and upstream value",
          status: d0.code === 0 && base0 === 1000 ? "info" : "fail",
          detail: `apply exit ${d0.code}; write requests: ${[...new Set(writes0.map((r) => `${r.method} ${scrub(r.path.replace(/\?.*$/, ""))}`))].join(", ") || "none"}; upstream max_rows=${base0}`,
          measurements: { exit: d0.code ?? -1, write_requests: writes0.length, upstream_max_rows: base0 },
          evidence: shape(ld0),
        });

        await arm(writeRules("error-before", 1));
        const d1 = await apply({ TF_VAR_enable_settings: "true", TF_VAR_max_rows: "500" });
        const ld1 = await px.log();
        const w1 = ld1.filter((r) => r.method !== "GET" && r.path.includes("/postgrest"));
        const upD1 = await upstreamRows();
        await arm([]);
        const p1 = await tofu(["plan", "-detailed-exitcode", "-no-color"], { TF_VAR_enable_settings: "true", TF_VAR_max_rows: "500" });
        results.push({
          id: "MF04d1",
          title: "MF04d1: settings update answered 500 before upstream, once",
          status: "info",
          detail: `apply exit ${d1.code}; ${w1.length} settings write attempt(s); upstream max_rows=${upD1} (wanted 500, was 1000); plan afterwards exit ${p1.code} (2 = changes pending)`,
          measurements: { exit: d1.code ?? -1, settings_write_attempts: w1.length, upstream_max_rows: upD1, plan_exit_after: p1.code ?? -1 },
          evidence: `${errLines(d1.stdout + d1.stderr)}\n${shape(ld1)}`,
        });
        await arm([]);
        await apply({ TF_VAR_enable_settings: "true", TF_VAR_max_rows: "500" });

        await arm(writeRules("error-after", 1));
        const d2 = await apply({ TF_VAR_enable_settings: "true", TF_VAR_max_rows: "250" });
        const ld2 = await px.log();
        const w2 = ld2.filter((r) => r.method !== "GET" && r.path.includes("/postgrest"));
        const upD2 = await upstreamRows();
        await arm([]);
        const p2 = await tofu(["plan", "-detailed-exitcode", "-no-color"], { TF_VAR_enable_settings: "true", TF_VAR_max_rows: "250" });
        results.push({
          id: "MF04d2",
          title: "MF04d2: settings update answered 500 AFTER upstream applied it, once",
          status: "info",
          detail: `apply exit ${d2.code}; ${w2.length} settings write attempt(s); upstream max_rows=${upD2} (wanted 250, was 500); plan afterwards exit ${p2.code} (0 = converged, 2 = changes pending)`,
          measurements: { exit: d2.code ?? -1, settings_write_attempts: w2.length, upstream_max_rows: upD2, plan_exit_after: p2.code ?? -1 },
          evidence: `${errLines(d2.stdout + d2.stderr)}\n${shape(ld2)}`,
        });

        // ---- MF04e: reads during plan/refresh ----
        const v = { TF_VAR_enable_settings: "true", TF_VAR_max_rows: "250" };
        const me: Record<string, number | string> = {};
        const le: string[] = [];
        const readCases: Array<{ label: string; rule: Rule; timeoutMs?: number }> = [
          { label: "500_once", rule: { id: "r500", method: "GET", path: "^/v1/projects/[a-z]{20}$", mode: "error-before", status: 500, times: 1 } },
          { label: "503_always", rule: { id: "r503", method: "GET", path: "^/v1/projects/[a-z]{20}$", mode: "error-before", status: 503 } },
          { label: "429_retry_after_1_once", rule: { id: "r429", method: "GET", path: "^/v1/projects/[a-z]{20}$", mode: "error-before", status: 429, times: 1, headers: { "retry-after": "1" } } },
          { label: "hold100_once", rule: { id: "hold", method: "GET", path: "^/v1/projects/[a-z]{20}$", mode: "delay-before", delayMs: 100_000, times: 1 }, timeoutMs: 300_000 },
        ];
        for (const c of readCases) {
          await arm([c.rule]);
          const r = await tofu(["plan", "-detailed-exitcode", "-no-color"], v, c.timeoutMs ?? 300_000);
          const lg = await px.log();
          const n = attempts(lg, "GET", PROJECT).length;
          me[`${c.label}_attempts`] = n;
          me[`${c.label}_exit`] = r.code ?? -1;
          me[`${c.label}_ms`] = r.ms;
          le.push(`${c.label}: ${n} GET attempt(s) on the project, plan exit ${r.code}, ${r.ms} ms${r.code === 1 ? ` (${errLines(r.stdout + r.stderr).slice(0, 160)})` : ""}`);
        }
        results.push({
          id: "MF04e",
          title: "MF04e: provider reads (plan refresh) through 500, 503, 429 and a 100 s hold",
          status: "info",
          detail: le.join("; "),
          measurements: me,
        });

        // ---- MF04f: destroy ----
        await arm([{ id: "del-before", method: "DELETE", path: "^/v1/projects/[a-z]{20}$", mode: "error-before", status: 500, times: 1 }]);
        const f1 = await tofu(["destroy", "-auto-approve", "-no-color"], v);
        const lf1 = await px.log();
        const stF1 = await stateList();
        const upF1 = await named();
        results.push({
          id: "MF04f1",
          title: "MF04f1: destroy with DELETE answered 500 before upstream, once",
          status: "info",
          detail: `destroy exit ${f1.code}; ${attempts(lf1, "DELETE", PROJECT).length} DELETE attempt(s); state ${stF1.length} resource(s); upstream projects ${upF1.length}`,
          measurements: { exit: f1.code ?? -1, delete_attempts: attempts(lf1, "DELETE", PROJECT).length, state_resources: stF1.length, upstream_projects: upF1.length },
          evidence: `${errLines(f1.stdout + f1.stderr)}\n${shape(lf1)}`,
        });
        if (stF1.length > 0) {
          await arm([{ id: "del-after", method: "DELETE", path: "^/v1/projects/[a-z]{20}$", mode: "error-after", status: 500, times: 1 }]);
          const f2 = await tofu(["destroy", "-auto-approve", "-no-color"], v);
          const lf2 = await px.log();
          const stF2 = await stateList();
          await Bun.sleep(8000);
          const upF2 = await named();
          results.push({
            id: "MF04f2",
            title: "MF04f2: destroy with DELETE answered 500 AFTER upstream accepted it, once",
            status: "info",
            detail: `destroy exit ${f2.code}; ${attempts(lf2, "DELETE", PROJECT).length} DELETE attempt(s) (upstream ${attempts(lf2, "DELETE", PROJECT)[0]?.upstreamStatus ?? "-"}); state ${stF2.length} resource(s); upstream projects ${upF2.length}`,
            measurements: { exit: f2.code ?? -1, delete_attempts: attempts(lf2, "DELETE", PROJECT).length, upstream_delete_status: attempts(lf2, "DELETE", PROJECT)[0]?.upstreamStatus ?? -1, state_resources: stF2.length, upstream_projects: upF2.length },
            evidence: `${errLines(f2.stdout + f2.stderr)}\n${shape(lf2)}`,
          });
          if (stF2.length > 0) {
            await waitGone(ctx, (n) => n === name, 180_000);
            await arm([]);
            const f3 = await tofu(["destroy", "-auto-approve", "-no-color"], v);
            const lf3 = await px.log();
            const stF3 = await stateList();
            results.push({
              id: "MF04f3",
              title: "MF04f3: clean destroy against state whose project is already gone upstream",
              status: "info",
              detail: `destroy exit ${f3.code}; requests: ${shape(lf3).split("\n").length} distinct; state ${stF3.length} resource(s)`,
              measurements: { exit: f3.code ?? -1, state_resources: stF3.length },
              evidence: `${errLines(f3.stdout + f3.stderr)}\n${shape(lf3)}`,
            });
          }
        }
      });
    } catch (e) {
      results.push({ id: "MF04", title: "MF04", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      // Clean up through the real API, never the proxy: it may be gone.
      await sweep(ctx).catch(() => 0);
      await waitGone(ctx, undefined, 180_000).catch(() => false);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return results;
  },
};
export default mod;
