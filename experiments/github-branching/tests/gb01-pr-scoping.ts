/**
 * GB01 - which pull requests create a preview branch on which project, and
 * what the checks on the head commit look like.
 *
 * Two projects are connected to one repository: A with workdir apps/a, B with
 * workdir apps/b. The run opens one pull request per shape, all at once, then
 * watches both projects' branch lists and the head commit's check-runs for the
 * full window:
 *
 *   root      README.md at the repository root (outside both workdirs)
 *   a-app     apps/a/README.md (inside A's workdir, outside apps/a/supabase/)
 *   a-db      a migration under apps/a/supabase/migrations/
 *   b-db      a migration under apps/b/supabase/migrations/
 *   both-db   one migration under each app
 *
 * Per shape: a_branch / b_branch (did that project create a preview branch for
 * the pull request's git branch within the window); runs_a / runs_b and
 * open_a / open_b (every check-run on the head commit, `filter=all`, attributed
 * to a project by the ref in its details_url, and how many were still not
 * completed at the end of the window); latest (which project the endpoint's
 * default view returns); latest_sequence (what the name-filtered default view -
 * the one the docs' wait action reads - showed over the first 150 s, sampled
 * every 3 s).
 *
 * The first run (2026-09-23 01:49 UTC) used an earlier revision that read only
 * the default view and never mapped preview refs, so its `*_checks` = 1 and
 * `both_identifying_fields` = none are what that code could see; the RUNLOG
 * carries the filter=all snapshot taken during that run.
 *
 * The toggle state is read at the start (same endpoint as GB00) and recorded
 * with the result, because the question is how the result changes with it: run
 * once per "Supabase changes only" setting.
 *
 * DESTRUCTIVE: creates git branches and pull requests in the probe repository
 * and preview branches (billed) on both projects. Cleanup closes the pull
 * requests, deletes the git branches, records which preview branches survive
 * the close, and deletes those.
 *
 * Not settled by this module: timing of branch creation beyond a first-seen
 * sample at the poll interval (and branch polling starts only after the 150 s
 * fast phase, so no first-seen time is under about 180 s); behaviour on pushes
 * that are not pull requests; anything about the Vercel integration.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  branchWithFiles,
  checkRuns,
  checkRunsNamed,
  closePr,
  commitStatuses,
  connections,
  deleteBranch,
  openPr,
  orgSlugOf,
  previewBranches,
  repoOf,
  sleep,
  type CheckRun,
} from "../lib/gh.js";

const ID = "GB01";
const TITLE = "PR shape x project: which previews get created, and which checks land";
const WINDOW_MS = 10 * 60_000;
const POLL_MS = 30_000;
const SETTLE_AFTER_CLOSE_MS = 2 * 60_000;
// What a wait-by-name step sees in the first minutes: the default (`latest`)
// view filtered to the check name, which is what the docs' example action reads.
const FAST_MS = 150_000;
const FAST_POLL_MS = 3_000;

const migration = (app: string, stamp: string) =>
  `-- probe migration for app ${app}\nalter table public.${app}_items add column if not exists note_${stamp} text;\n`;

function shapes(stamp: string): Record<string, Record<string, string>> {
  return {
    root: { "README.md": `# Monorepo fixture\n\nroot edit ${stamp}\n` },
    "a-app": { "apps/a/README.md": `# app a\n\nedit ${stamp}\n` },
    "a-db": { [`apps/a/supabase/migrations/${stamp}_probe.sql`]: migration("a", stamp) },
    "b-db": { [`apps/b/supabase/migrations/${stamp}_probe.sql`]: migration("b", stamp) },
    "both-db": {
      [`apps/a/supabase/migrations/${stamp}_probe.sql`]: migration("a", stamp),
      [`apps/b/supabase/migrations/${stamp}_probe.sql`]: migration("b", stamp),
    },
  };
}

interface Obs {
  git: string;
  sha: string;
  pr: number;
  aSeenS: number;
  bSeenS: number;
  /** The preview branch's own project ref, once it exists. */
  aPreview: string;
  bPreview: string;
  checks: CheckRun[];
  latest: CheckRun[];
  /** Distinct consecutive states of the name-filtered `latest` view. */
  seen: { t: number; runs: { id: number; status: string; conclusion: string; details_url: string }[] }[];
}

/**
 * Which project a check-run belongs to. Early runs link the parent project's
 * branches page, later ones the preview branch's own project, so both refs
 * count. Returns the field that carried it, or "none".
 */
function attribute(c: CheckRun, a: string[], b: string[]): { project: "A" | "B" | "?"; field: string } {
  for (const f of ["external_id", "details_url", "title", "summary"] as const) {
    if (a.some((r) => r && c[f].includes(r))) return { project: "A", field: f };
    if (b.some((r) => r && c[f].includes(r))) return { project: "B", field: f };
  }
  return { project: "?", field: "none" };
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
    const ca = conns.rows.find((c) => c.project_ref === refs.a);
    const cb = conns.rows.find((c) => c.project_ref === refs.b);
    const toggle = `A=${ca?.supabase_changes_only ?? "?"},B=${cb?.supabase_changes_only ?? "?"}`;

    // Timestamp shaped like a migration version, so the probe migration sorts
    // after the fixture's init migration.
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const obs: Record<string, Obs> = {};
    for (const [shape, files] of Object.entries(shapes(stamp))) {
      const git = `gb01-${stamp}-${shape}`;
      const sha = branchWithFiles(repo, "main", git, files, `probe: ${shape}`);
      const pr = openPr(repo, git, "main", `GB01 ${shape} (${stamp})`);
      obs[shape] = { git, sha, pr, aSeenS: -1, bSeenS: -1, aPreview: "", bPreview: "", checks: [], latest: [], seen: [] };
      ctx.log(`${shape}: PR #${pr} on ${git}`);
    }

    const tf = Date.now();
    while (Date.now() - tf < FAST_MS) {
      for (const o of Object.values(obs)) {
        const runs = checkRunsNamed(repo, o.sha, "Supabase Preview").map((c) => ({ id: c.id, status: c.status, conclusion: c.conclusion, details_url: c.details_url }));
        const key = JSON.stringify(runs);
        if (key !== JSON.stringify(o.seen.at(-1)?.runs)) o.seen.push({ t: Math.round((Date.now() - tf) / 1000), runs });
      }
      await sleep(FAST_POLL_MS);
    }

    // Full window regardless: a "no preview" result has to be earned by
    // waiting, not assumed from a fast positive elsewhere.
    const t0 = tf; // first-seen times count from the PRs opening, fast phase included
    while (Date.now() - t0 < WINDOW_MS) {
      await sleep(POLL_MS);
      const s = Math.round((Date.now() - t0) / 1000);
      const [ba, bb] = [await previewBranches(ctx, refs.a), await previewBranches(ctx, refs.b)];
      for (const o of Object.values(obs)) {
        const pa = ba.find((b) => b.git_branch === o.git);
        const pb = bb.find((b) => b.git_branch === o.git);
        if (pa && o.aSeenS < 0) o.aSeenS = s;
        if (pb && o.bSeenS < 0) o.bSeenS = s;
        if (pa?.project_ref) o.aPreview = pa.project_ref;
        if (pb?.project_ref) o.bPreview = pb.project_ref;
        o.checks = checkRuns(repo, o.sha, "all");
        o.latest = checkRuns(repo, o.sha, "latest");
      }
    }

    const statuses = Object.fromEntries(Object.entries(obs).map(([k, o]) => [k, commitStatuses(repo, o.sha)]));

    // Cleanup, and what it tells us: does closing the PR remove the preview?
    for (const o of Object.values(obs)) {
      closePr(repo, o.pr);
      deleteBranch(repo, o.git);
    }
    await sleep(SETTLE_AFTER_CLOSE_MS);
    const gits = new Set(Object.values(obs).map((o) => o.git));
    const leftovers = [...(await previewBranches(ctx, refs.a)), ...(await previewBranches(ctx, refs.b))].filter((b) => gits.has(b.git_branch));
    for (const b of leftovers) await mgmt(ctx, "DELETE", `/branches/${b.id}`);

    const m: Record<string, string | number> = { toggle_changes_only: toggle, window_s: WINDOW_MS / 1000 };
    const lines: string[] = [];
    const fields = new Set<string>();
    const attributed: Record<string, unknown> = {};
    for (const [shape, o] of Object.entries(obs)) {
      const aRefs = [refs.a, o.aPreview];
      const bRefs = [refs.b, o.bPreview];
      const runs = o.checks.filter((c) => c.app === "supabase");
      const tagged = runs.map((c) => ({ ...attribute(c, aRefs, bRefs), status: c.status, conclusion: c.conclusion, started_at: c.started_at }));
      tagged.forEach((t) => fields.add(t.field));
      const per = (p: string) => tagged.filter((t) => t.project === p);
      const open = (p: string) => per(p).filter((t) => t.status !== "completed").length;
      const latest = o.latest.filter((c) => c.app === "supabase").map((c) => attribute(c, aRefs, bRefs).project);
      m[`${shape}_a_branch`] = o.aSeenS >= 0 ? `yes@${o.aSeenS}s` : "no";
      m[`${shape}_b_branch`] = o.bSeenS >= 0 ? `yes@${o.bSeenS}s` : "no";
      m[`${shape}_runs_a`] = per("A").length;
      m[`${shape}_runs_b`] = per("B").length;
      m[`${shape}_open_a`] = open("A");
      m[`${shape}_open_b`] = open("B");
      m[`${shape}_latest`] = latest.join("|") || "none";
      const seenStates = o.seen.map((x) => x.runs.map((r) => `${attribute({ ...r, name: "", app: "", external_id: "", title: "", summary: "", started_at: "", suite: 0 } as CheckRun, aRefs, bRefs).project}:${r.status === "completed" ? r.conclusion : r.status}`).join("+") || "none");
      m[`${shape}_latest_sequence`] = seenStates.join(">");
      m[`${shape}_names`] = [...new Set(runs.map((c) => c.name))].join("|");
      attributed[shape] = tagged;
      lines.push(`${shape}: A ${m[`${shape}_a_branch`]} (${per("A").length} runs, ${open("A")} open), B ${m[`${shape}_b_branch`]} (${per("B").length} runs, ${open("B")} open), default view shows ${m[`${shape}_latest`]}`);
    }
    m.identifying_fields = [...fields].join("|");
    m.leftover_after_close = leftovers.length;

    return {
      id: ID,
      title: TITLE,
      status: "info",
      detail: `changes_only ${toggle}. ${lines.join("; ")}. Run attributed by: ${m.identifying_fields || "n/a"}. Previews left 2 min after close: ${leftovers.length}.`,
      measurements: m,
      evidence: JSON.stringify(
        {
          toggle,
          connections: [ca, cb].map((c) => c && { ...c, project_ref: c.project_ref === refs.a ? "A" : "B" }),
          shapes: Object.fromEntries(Object.entries(obs).map(([k, o]) => [k, { pr: o.pr, a_seen_s: o.aSeenS, b_seen_s: o.bSeenS, runs: attributed[k], latest_by_name: o.seen, statuses: statuses[k] }])),
          leftovers: leftovers.map((b) => ({ git_branch: b.git_branch, status: b.status })),
        },
        null,
        2,
      ),
    };
  },
};
export default mod;
