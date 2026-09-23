/**
 * GB03 - a per-project readiness signal that does not depend on the check name.
 *
 * GB01/GB02 found the check-runs unusable for "wait for MY project's preview":
 * every run is named "Supabase Preview", the default view shows one of them,
 * and the check_run_id an action run reports points at a run left in_progress.
 * The Management API is keyed by project, so this module watches what it
 * says per project when one project's preview FAILS and the other's succeeds.
 *
 *   one pull request: a migration under apps/a that errors (references a
 *   table that does not exist), and a valid migration under apps/b
 *
 * Per project, sampled every 15 s for the 480 s window: the branch's `status` from
 * GET /v1/projects/{parent}/branches (matched on git_branch; the field is
 * marked deprecated in the spec, which points at action runs instead), the
 * latest action run's steps from GET /v1/projects/{preview}/actions, and the
 * project's check-run conclusions on the head commit (details_url attribution).
 * Recorded as the distinct sequence of states per signal.
 *
 * DESTRUCTIVE: opens a pull request, creates two billed preview branches.
 * Cleanup as GB01.
 *
 * Not settled by this module: failures other than a migration error (seed,
 * config, function deploy), and whether action-run step statuses distinguish
 * a failed step from a finished one (the spec's enum is container states).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  actionRuns,
  branchWithFiles,
  checkRuns,
  closePr,
  connections,
  deleteBranch,
  openPr,
  orgSlugOf,
  previewBranches,
  repoOf,
  sleep,
  type CheckRun,
} from "../lib/gh.js";

const ID = "GB03";
const TITLE = "per-project signal when A's preview fails and B's succeeds";
const WINDOW_MS = 8 * 60_000;
const POLL_MS = 15_000;
const SETTLE_AFTER_CLOSE_MS = 2 * 60_000;

function project(c: Pick<CheckRun, "details_url">, a: string[], b: string[]): "A" | "B" | "?" {
  if (a.some((r) => r && c.details_url.includes(r))) return "A";
  if (b.some((r) => r && c.details_url.includes(r))) return "B";
  return "?";
}

/** Append `v` when it differs from the last entry, with the time it was first seen. */
function push(seq: string[], t: number, v: string) {
  if (seq.length === 0 || !seq[seq.length - 1]!.endsWith(`=${v}`)) seq.push(`${t}s=${v}`);
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
    const conns = await connections(ctx, await orgSlugOf(ctx, refs.a));
    const toggle = `A=${conns.rows.find((c) => c.project_ref === refs.a)?.supabase_changes_only ?? "?"},B=${conns.rows.find((c) => c.project_ref === refs.b)?.supabase_changes_only ?? "?"}`;

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const git = `gb03-${stamp}-a-fails`;
    const sha = branchWithFiles(
      repo,
      "main",
      git,
      {
        [`apps/a/supabase/migrations/${stamp}_broken.sql`]: `-- deliberately broken: the table does not exist\nalter table public.no_such_table add column x text;\n`,
        [`apps/b/supabase/migrations/${stamp}_ok.sql`]: `alter table public.b_items add column if not exists ok_${stamp} text;\n`,
      },
      "probe: A migration errors, B migration valid",
    );
    const pr = openPr(repo, git, "main", `GB03 A fails, B succeeds (${stamp})`);
    ctx.log(`PR #${pr} on ${git}`);

    const seq: Record<string, string[]> = { a_status: [], b_status: [], a_action: [], b_action: [], a_checks: [], b_checks: [] };
    const preview = { a: "", b: "" };
    const t0 = Date.now();
    while (Date.now() - t0 < WINDOW_MS) {
      await sleep(POLL_MS);
      const t = Math.round((Date.now() - t0) / 1000);
      for (const k of ["a", "b"] as const) {
        const br = (await previewBranches(ctx, refs[k])).find((b) => b.git_branch === git);
        if (br?.project_ref) preview[k] = br.project_ref;
        push(seq[`${k}_status`]!, t, br?.status || "absent");
        if (preview[k]) {
          const runs = await actionRuns(ctx, preview[k]);
          const latest = runs.sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
          push(seq[`${k}_action`]!, t, latest?.steps || "none");
        }
      }
      const checks = checkRuns(repo, sha, "all");
      for (const k of ["a", "b"] as const) {
        const mine = checks.filter((c) => project(c, [refs.a, preview.a], [refs.b, preview.b]) === k.toUpperCase());
        push(seq[`${k}_checks`]!, t, mine.map((c) => (c.status === "completed" ? c.conclusion : c.status)).sort().join("+") || "none");
      }
    }

    closePr(repo, pr);
    deleteBranch(repo, git);
    await sleep(SETTLE_AFTER_CLOSE_MS);
    const leftovers = [...(await previewBranches(ctx, refs.a)), ...(await previewBranches(ctx, refs.b))].filter((b) => b.git_branch === git);
    for (const b of leftovers) await mgmt(ctx, "DELETE", `/branches/${b.id}`);

    const last = (s: string[]) => (s.at(-1) ?? "").replace(/^\d+s=/, "");
    const m: Record<string, string | number> = {
      toggle_changes_only: toggle,
      window_s: WINDOW_MS / 1000,
      a_final_status: last(seq.a_status!),
      b_final_status: last(seq.b_status!),
      a_final_checks: last(seq.a_checks!),
      b_final_checks: last(seq.b_checks!),
      a_final_action: last(seq.a_action!),
      b_final_action: last(seq.b_action!),
      leftover_after_close: leftovers.length,
    };
    return {
      id: ID,
      title: TITLE,
      status: "info",
      detail: `changes_only ${toggle}. A (broken migration): status ${m.a_final_status}, checks ${m.a_final_checks}. B (valid): status ${m.b_final_status}, checks ${m.b_final_checks}.`,
      measurements: m,
      evidence: JSON.stringify({ pr, sequences: seq }, null, 2),
    };
  },
};
export default mod;
