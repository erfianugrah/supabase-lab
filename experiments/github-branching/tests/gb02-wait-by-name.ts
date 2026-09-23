/**
 * GB02 - what the branching docs' wait-by-check-name workflow returns when two
 * projects post "Supabase Preview" to the same commits, and whether the
 * Management API's action runs identify each project's check-run.
 *
 * Setup: fixture-ci/wait-a.yaml on main as .github/workflows/wait-a.yaml
 * (`make push-ci`). It is the docs' `wait` + `migrate` pair with
 * the path filter set to apps/a/supabase/** and the migrate job reduced to an
 * echo, so it asks one thing: did the wait step hand app A's job the result of
 * app A's preview?
 *
 *   a-db     migration under apps/a only (B posts checks too: skipped ones,
 *            when "Supabase changes only" is on - GB01)
 *   both-db  migration under each app (both projects branch)
 *
 * Per shape: the wait job's pick (check-run id + conclusion, from the action's
 * own log line), which project that run belongs to (details_url, as GB01),
 * whether the migrate job ran, and whether A's preview had succeeded yet.
 * Action runs: every `check_run_id` from GET /v1/projects/{ref}/actions on the
 * parent and preview refs, matched against the commit's check-runs.
 *
 * DESTRUCTIVE: commits the workflow to main, opens pull requests, creates
 * billed preview branches. Cleanup as GB01.
 *
 * Not settled by this module: timing on a busy runner pool (the race depends
 * on how soon the job's first poll lands); other wait actions, which may read
 * the check-runs endpoint differently.
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
  ghApi,
  repoOf,
  sleep,
  waitActionPick,
  workflowRuns,
  type ActionRun,
  type CheckRun,
} from "../lib/gh.js";

const ID = "GB02";
const TITLE = "docs wait-by-name workflow with two projects: which run does it pick";
const WINDOW_MS = 10 * 60_000;
const POLL_MS = 30_000;
const SETTLE_AFTER_CLOSE_MS = 2 * 60_000;
const WORKFLOW_PATH = ".github/workflows/wait-a.yaml";

const migration = (app: string, stamp: string) =>
  `-- probe migration for app ${app}\nalter table public.${app}_items add column if not exists wait_${stamp} text;\n`;

function project(c: Pick<CheckRun, "details_url">, a: string[], b: string[]): "A" | "B" | "?" {
  if (a.some((r) => r && c.details_url.includes(r))) return "A";
  if (b.some((r) => r && c.details_url.includes(r))) return "B";
  return "?";
}

interface Obs {
  git: string;
  sha: string;
  pr: number;
  aPreview: string;
  bPreview: string;
  checks: CheckRun[];
  actions: { where: string; run: ActionRun }[];
  firstASuccessT: number;
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

    // The workflow goes onto main with `make push-ci` (SSH): the REST contents
    // API refuses .github/workflows/ writes from a token without the `workflow`
    // scope. Here we only check it is there.
    if (!ghApi("GET", `repos/${repo}/contents/${WORKFLOW_PATH}?ref=main`).ok) {
      return { id: ID, title: TITLE, status: "skip", detail: `${WORKFLOW_PATH} not on main - run make push-ci first` };
    }

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const shapes: Record<string, Record<string, string>> = {
      "a-db": { [`apps/a/supabase/migrations/${stamp}_wait.sql`]: migration("a", stamp) },
      "both-db": {
        [`apps/a/supabase/migrations/${stamp}_wait.sql`]: migration("a", stamp),
        [`apps/b/supabase/migrations/${stamp}_wait.sql`]: migration("b", stamp),
      },
    };
    const obs: Record<string, Obs> = {};
    const t0 = Date.now();
    for (const [shape, files] of Object.entries(shapes)) {
      const git = `gb02-${stamp}-${shape}`;
      const sha = branchWithFiles(repo, "main", git, files, `probe: ${shape}`);
      const pr = openPr(repo, git, "main", `GB02 ${shape} (${stamp})`);
      obs[shape] = { git, sha, pr, aPreview: "", bPreview: "", checks: [], actions: [], firstASuccessT: -1 };
      ctx.log(`${shape}: PR #${pr} on ${git}`);
    }

    while (Date.now() - t0 < WINDOW_MS) {
      await sleep(POLL_MS);
      const [ba, bb] = [await previewBranches(ctx, refs.a), await previewBranches(ctx, refs.b)];
      for (const o of Object.values(obs)) {
        o.aPreview = ba.find((b) => b.git_branch === o.git)?.project_ref ?? o.aPreview;
        o.bPreview = bb.find((b) => b.git_branch === o.git)?.project_ref ?? o.bPreview;
        o.checks = checkRuns(repo, o.sha, "all");
        const aRuns = o.checks.filter((c) => project(c, [refs.a, o.aPreview], [refs.b, o.bPreview]) === "A");
        if (o.firstASuccessT < 0 && aRuns.some((c) => c.conclusion === "success")) o.firstASuccessT = Math.round((Date.now() - t0) / 1000);
      }
    }

    // Action runs, read before cleanup removes the preview projects.
    for (const o of Object.values(obs)) {
      for (const [where, ref] of [["A-parent", refs.a], ["B-parent", refs.b], ["A-preview", o.aPreview], ["B-preview", o.bPreview]] as const) {
        if (!ref) continue;
        for (const run of await actionRuns(ctx, ref)) o.actions.push({ where, run });
      }
    }

    const m: Record<string, string | number> = { toggle_changes_only: toggle, window_s: WINDOW_MS / 1000 };
    const ev: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const [shape, o] of Object.entries(obs)) {
      const aRefs = [refs.a, o.aPreview];
      const bRefs = [refs.b, o.bPreview];
      const wfs = workflowRuns(repo, o.sha);
      const wfRun = wfs[0];
      const pick = wfRun ? waitActionPick(repo, wfRun.id) : null;
      const picked = pick ? o.checks.find((c) => c.id === pick.id) : undefined;
      const pickedProject = picked ? project(picked, aRefs, bRefs) : "?";
      const migrate = wfRun?.jobs.find((j) => j.name === "migrate");
      const byId = new Map(o.checks.map((c) => [c.id, c]));
      const mapped = o.actions
        .filter((x) => x.run.check_run_id !== null)
        .map((x) => {
          const c = byId.get(x.run.check_run_id as number);
          return { where: x.where, check_run_id: x.run.check_run_id, on_commit: Boolean(c), check_project: c ? project(c, aRefs, bRefs) : "", check_state: c ? `${c.status}/${c.conclusion}` : "", steps: x.run.steps };
        });
      const onCommit = mapped.filter((x) => x.on_commit);
      const agree = onCommit.filter((x) => x.where.startsWith(x.check_project)).length;
      m[`${shape}_workflow_runs`] = wfs.length;
      m[`${shape}_wait_conclusion`] = pick?.conclusion ?? "no pick logged";
      m[`${shape}_wait_picked_project`] = pickedProject;
      m[`${shape}_migrate_job`] = migrate ? migrate.conclusion || migrate.status : "absent";
      m[`${shape}_a_first_success_s`] = o.firstASuccessT;
      m[`${shape}_action_runs_with_check_id`] = mapped.length;
      m[`${shape}_action_check_ids_on_commit`] = onCommit.length;
      m[`${shape}_action_project_agrees`] = agree;
      lines.push(`${shape}: wait returned ${m[`${shape}_wait_conclusion`]} from project ${pickedProject}, migrate ${m[`${shape}_migrate_job`]}; A's first success at ${o.firstASuccessT}s; ${onCommit.length}/${mapped.length} action-run check ids on the commit, ${agree} agreeing on project`);
      ev[shape] = {
        pr: o.pr,
        workflow: wfs,
        pick,
        picked: picked && { status: picked.status, conclusion: picked.conclusion, started_at: picked.started_at, project: pickedProject },
        runs: o.checks.map((c) => ({ id: c.id, project: project(c, aRefs, bRefs), status: c.status, conclusion: c.conclusion, started_at: c.started_at })),
        action_runs: mapped,
      };
    }

    for (const o of Object.values(obs)) {
      closePr(repo, o.pr);
      deleteBranch(repo, o.git);
    }
    await sleep(SETTLE_AFTER_CLOSE_MS);
    const gits = new Set(Object.values(obs).map((o) => o.git));
    const leftovers = [...(await previewBranches(ctx, refs.a)), ...(await previewBranches(ctx, refs.b))].filter((b) => gits.has(b.git_branch));
    for (const b of leftovers) await mgmt(ctx, "DELETE", `/branches/${b.id}`);
    m.leftover_after_close = leftovers.length;

    return {
      id: ID,
      title: TITLE,
      status: "info",
      detail: `changes_only ${toggle}. ${lines.join("; ")}.`,
      measurements: m,
      evidence: JSON.stringify(ev, null, 2),
    };
  },
};
export default mod;
