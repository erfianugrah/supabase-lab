/**
 * GB06 - merging a pull request that changes only app A: does project B run a
 * production deploy too?
 *
 * Both projects have Deploy to production on, with `main` as the production
 * branch (the default branch row's git_branch reads `main`; the module skips
 * otherwise). The run opens a pull request with a migration under
 * apps/a/supabase/, waits for A's preview to settle, merges it, then watches
 * both parent projects' action runs (GET /v1/projects/{ref}/actions) for 4
 * minutes, counting runs created after the merge, and reads the migrations
 * list on both parents.
 *
 *   a_prod_runs / b_prod_runs    action runs created on each parent after the merge
 *   a_has_migration / b_has_...  the merged migration's version in each parent's
 *                                GET /v1/projects/{ref}/database/migrations
 *   merge_commit_checks          check-runs on the merge commit, by project
 *
 * DESTRUCTIVE: merges into main (the probe repository's), applies a migration to
 * project A's production database, creates a billed preview branch.
 *
 * Not settled by this module: a merge that touches only non-Supabase files;
 * "Supabase changes only" off.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  actionRuns,
  branchWithFiles,
  checkRuns,
  deleteBranch,
  ghApi,
  openPr,
  previewBranches,
  repoOf,
  sleep,
} from "../lib/gh.js";

const ID = "GB06";
const TITLE = "merging an A-only pull request: production runs on A and B";
const POLL_MS = 20_000;
const WATCH_MS = 4 * 60_000;

async function mainGit(ctx: Ctx, ref: string): Promise<string> {
  const rows = await previewBranches(ctx, ref);
  return rows.find((b) => b.is_default)?.git_branch ?? "";
}

async function migrationVersions(ctx: Ctx, ref: string): Promise<string[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/database/migrations`);
  return Array.isArray(r.json) ? (r.json as { version?: string }[]).map((x) => String(x.version ?? "")) : [];
}

const mod: TestModule = {
  id: ID,
  title: TITLE,
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult> {
    const repo = repoOf(ctx);
    if (!repo) return { id: ID, title: TITLE, status: "skip", detail: "no PVLAB_ENDPOINT_REPO (owner/name)" };
    const refs = { a: ctx.ref, b: ctx.peers.b ?? "" };
    const [ga, gb] = [await mainGit(ctx, refs.a), await mainGit(ctx, refs.b)];
    if (ga !== "main" || gb !== "main") {
      return { id: ID, title: TITLE, status: "skip", detail: `needs Deploy to production on main for both (A=${ga || "none"}, B=${gb || "none"})` };
    }

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const version = stamp;
    const git = `gb06-${stamp}-a-merge`;
    branchWithFiles(repo, "main", git, { [`apps/a/supabase/migrations/${version}_merge.sql`]: `alter table public.a_items add column if not exists m_${stamp} text;\n` }, "probe: A-only migration to merge");
    const pr = openPr(repo, git, "main", `GB06 A-only merge (${stamp})`);

    // Let A's preview settle so the merge is the only thing in flight.
    const t0 = Date.now();
    let settled = "";
    while (Date.now() - t0 < 6 * 60_000) {
      await sleep(POLL_MS);
      settled = (await previewBranches(ctx, refs.a)).find((b) => b.git_branch === git)?.status ?? "absent";
      if (settled === "FUNCTIONS_DEPLOYED" && Date.now() - t0 > 60_000) break;
    }

    const before = { a: new Set((await actionRuns(ctx, refs.a)).map((r) => r.id)), b: new Set((await actionRuns(ctx, refs.b)).map((r) => r.id)) };
    const merge = ghApi("PUT", `repos/${repo}/pulls/${pr}/merge`, { merge_method: "squash" });
    const mergeSha = String((merge.json as { sha?: string })?.sha ?? "");
    const tm = Date.now();
    ctx.log(`merged PR #${pr}: ${merge.status}`);

    let newA: string[] = [];
    let newB: string[] = [];
    while (Date.now() - tm < WATCH_MS) {
      await sleep(POLL_MS);
      newA = (await actionRuns(ctx, refs.a)).filter((r) => !before.a.has(r.id)).map((r) => r.steps);
      newB = (await actionRuns(ctx, refs.b)).filter((r) => !before.b.has(r.id)).map((r) => r.steps);
    }
    const [va, vb] = [await migrationVersions(ctx, refs.a), await migrationVersions(ctx, refs.b)];
    const checks = mergeSha ? checkRuns(repo, mergeSha, "all").filter((c) => c.app === "supabase") : [];
    const byProject = (r: string) => checks.filter((c) => c.details_url.includes(r)).map((c) => `${c.status === "completed" ? c.conclusion : c.status}`);
    deleteBranch(repo, git);

    const m: Record<string, string | number> = {
      preview_before_merge: settled,
      merge_status: merge.status,
      a_prod_runs: newA.length,
      b_prod_runs: newB.length,
      a_has_migration: String(va.includes(version)),
      b_has_migration: String(vb.includes(version)),
      merge_commit_checks_a: byProject(refs.a).join("+") || "none",
      merge_commit_checks_b: byProject(refs.b).join("+") || "none",
      merge_commit_checks_total: checks.length,
      watch_s: WATCH_MS / 1000,
    };
    return {
      id: ID,
      title: TITLE,
      status: "info",
      detail: `merge ${merge.status}. New action runs after merge: A ${newA.length}, B ${newB.length}. Migration ${version} on A ${m.a_has_migration}, on B ${m.b_has_migration}. Supabase check-runs on the merge commit: A ${m.merge_commit_checks_a}; B ${m.merge_commit_checks_b}.`,
      measurements: m,
      evidence: JSON.stringify({ new_action_runs: { a: newA, b: newB } }, null, 2),
    };
  },
};
export default mod;
