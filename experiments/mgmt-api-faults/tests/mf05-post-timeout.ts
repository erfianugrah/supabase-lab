/**
 * MF05 - a project create whose answer arrives after the client's own timeout.
 *
 * MF03e measured the CLI giving up on a held GET after 60 s per attempt and
 * retrying it. A POST that upstream completes but the client abandons is the
 * duplicate-create hazard, so the question is whether the CLI retries a POST
 * on a transport timeout the way it does not on a 5xx status (MF03c).
 *
 *   MF05a  CLI `projects create`, proxy forwards then holds the answer 75 s
 *          (delay-after): POST attempts, exit code, and how many projects
 *          carry the name afterwards (the platform rejects a repeat name in
 *          an org with 400, MF02c).
 *   MF05b  OpenTofu provider create, proxy holds the answer 130 s once: does
 *          the provider give up, how many POSTs.
 *
 * Creates one project per sub-case; both are swept in `finally`.
 */
import { copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { attempts, dbPassword, listPrefixed, missingTool, NAME_PREFIX, runCmd, scratchDir, scrub, shape, sweep, waitGone, withProxy } from "../lib/proxy.js";

const POST = /^\/v1\/projects$/;
const TF_SRC = resolve(import.meta.dir, "../tf");

const mod: TestModule = {
  id: "MF05",
  title: "Create answered after the client timeout: CLI and OpenTofu provider",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF05", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = await missingTool(["docker", "supabase", "tofu"]);
    if (missing) return [{ id: "MF05", title: this.title, status: "skip", detail: missing }];
    const results: TestResult[] = [];
    const dir = scratchDir("post-timeout");
    try {
      await withProxy(async (px) => {
        // ---- MF05a: CLI ----
        const profile = join(dir, "profile.yaml");
        writeFileSync(profile, `name: mf\napi_url: ${px.url}\ndashboard_url: ${px.url}\ndocs_url: ${px.url}\nproject_host: supabase.co\n`);
        const nameA = `${NAME_PREFIX}to-cli-${Date.now()}`;
        await px.reset();
        await px.setRules([{ id: "hold75", method: "POST", path: "^/v1/projects$", mode: "delay-after", delayMs: 75_000 }]);
        const a = await runCmd(
          ["supabase", "--profile", profile, "--workdir", dir, "projects", "create", nameA, "--org-id", org, "--db-password", dbPassword(), "--region", "ap-southeast-1", "--yes"],
          { cwd: dir, env: { SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" }, timeoutMs: 420_000 },
        );
        await Bun.sleep(80_000); // let any in-flight held answers drain before counting
        const la = await px.log();
        const posts = attempts(la, "POST", POST);
        const namedA = (await listPrefixed(ctx)).filter((p) => p.name === nameA);
        results.push({
          id: "MF05a",
          title: "MF05a: CLI create whose answer is held 75 s",
          status: "info",
          detail: `exit ${a.code} after ${a.ms} ms; ${posts.length} POST attempt(s) (upstream statuses ${posts.map((r) => r.upstreamStatus ?? "-").join(",")}); projects with the name: ${namedA.length}`,
          measurements: { exit: a.code ?? -1, ms: a.ms, post_attempts: posts.length, projects_with_name: namedA.length, first_upstream_status: posts[0]?.upstreamStatus ?? -1 },
          evidence: scrub(`${a.stdout.slice(0, 300)} ${a.stderr.slice(0, 200)}\n${shape(la)}`),
        });
        await sweep(ctx, (n) => n === nameA);
        await waitGone(ctx, (n) => n === nameA);

        // ---- MF05b: provider ----
        const nameB = `${NAME_PREFIX}to-tf-${Date.now()}`;
        copyFileSync(join(TF_SRC, "main.tf"), join(dir, "main.tf"));
        copyFileSync(join(TF_SRC, ".terraform.lock.hcl"), join(dir, ".terraform.lock.hcl"));
        const init = await runCmd(["tofu", `-chdir=${dir}`, "init", "-no-color", "-input=false"], { timeoutMs: 180_000 });
        if (init.code !== 0) {
          results.push({ id: "MF05b", title: "MF05b init", status: "fail", detail: `tofu init exit ${init.code}` });
          return;
        }
        await px.reset();
        await px.setRules([{ id: "hold130", method: "POST", path: "^/v1/projects$", mode: "delay-after", delayMs: 130_000, times: 1 }]);
        const b = await runCmd(["tofu", `-chdir=${dir}`, "apply", "-auto-approve", "-no-color"], {
          env: {
            TF_IN_AUTOMATION: "1", TF_INPUT: "0", TF_VAR_endpoint: px.url, TF_VAR_access_token: ctx.pat ?? "",
            TF_VAR_org_id: org, TF_VAR_project_name: nameB, TF_VAR_db_password: dbPassword(),
          },
          timeoutMs: 420_000,
        });
        const lb = await px.log();
        const postsB = attempts(lb, "POST", POST);
        const namedB = (await listPrefixed(ctx)).filter((p) => p.name === nameB);
        results.push({
          id: "MF05b",
          title: "MF05b: provider create whose answer is held 130 s, once",
          status: "info",
          detail: `apply exit ${b.code} after ${b.ms} ms; ${postsB.length} POST attempt(s); projects with the name: ${namedB.length}`,
          measurements: { exit: b.code ?? -1, ms: b.ms, post_attempts: postsB.length, projects_with_name: namedB.length },
          evidence: scrub(`${(b.stdout + b.stderr).split("\n").filter((l) => /Error/.test(l)).slice(0, 3).join(" | ")}\n${shape(lb)}`),
        });
      });
    } catch (e) {
      results.push({ id: "MF05", title: "MF05", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await sweep(ctx).catch(() => 0);
      await waitGone(ctx, undefined, 180_000).catch(() => false);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return results;
  },
};
export default mod;
