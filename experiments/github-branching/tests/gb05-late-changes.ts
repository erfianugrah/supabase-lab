/**
 * GB05 - with "Supabase changes only" on, what happens to changes that arrive
 * after the pull request opened.
 *
 *   late    a pull request opened with apps/a/README.md only (no preview
 *           expected), then a commit adding a migration under
 *           apps/a/supabase/ pushed to it, then the pull request closed and
 *           reopened. Records whether A creates a preview after the push, and
 *           after the reopen.
 *   reseed  a pull request opened with a migration under apps/a/supabase/
 *           (A previews), then, once the preview has run, a commit changing
 *           apps/a/supabase/seed.sql pushed to it. Records whether the new seed
 *           row appears in A's preview database. The integration's own pull
 *           request comment says "only new migration files are pushed" on
 *           later commits (GB04); this checks it.
 *
 * Phase timings are fixed (below) and recorded; "no" means not seen by the end
 * of that phase at a 20 s poll.
 *
 * DESTRUCTIVE: git branches, pull requests, billed preview branches. Cleanup
 * as GB01.
 *
 * Not settled by this module: a push that changes an existing migration file;
 * pushes to the base branch; timing beyond the phase lengths.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql } from "../../../harness/src/platform.js";
import {
  branchWithFiles,
  closePr,
  connections,
  deleteBranch,
  ghApi,
  headSha,
  openPr,
  orgSlugOf,
  previewBranches,
  repoOf,
  sleep,
} from "../lib/gh.js";

const ID = "GB05";
const TITLE = "changes-only on: Supabase changes pushed after open, reopen, and seed on push";
const POLL_MS = 20_000;
const PHASE_MS = 4 * 60_000;
const SETTLE_AFTER_CLOSE_MS = 2 * 60_000;

/** Add one commit writing `files` on top of `branch`. */
function pushCommit(repo: string, branch: string, files: Record<string, string>, message: string): boolean {
  const parent = headSha(repo, branch);
  const base = ghApi("GET", `repos/${repo}/git/commits/${parent}`).json as { tree: { sha: string } };
  const tree = ghApi("POST", `repos/${repo}/git/trees`, {
    base_tree: base.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  const commit = ghApi("POST", `repos/${repo}/git/commits`, { message, tree: (tree.json as { sha: string }).sha, parents: [parent] });
  return ghApi("PATCH", `repos/${repo}/git/refs/heads/${branch}`, { sha: (commit.json as { sha: string }).sha }).ok;
}

function fileContent(repo: string, path: string): string {
  const r = ghApi("GET", `repos/${repo}/contents/${path}?ref=main`);
  return Buffer.from(String((r.json as { content?: string })?.content ?? ""), "base64").toString("utf8");
}

async function watchPreview(ctx: Ctx, ref: string, git: string, ms: number): Promise<{ seenS: number; previewRef: string; status: string }> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(POLL_MS);
    const b = (await previewBranches(ctx, ref)).find((x) => x.git_branch === git);
    if (b) return { seenS: Math.round((Date.now() - t0) / 1000), previewRef: b.project_ref, status: b.status };
  }
  return { seenS: -1, previewRef: "", status: "" };
}

/** Wait until the preview's branch status has passed through a busy state and settled. */
async function waitSettled(ctx: Ctx, ref: string, git: string, ms: number): Promise<string> {
  const t0 = Date.now();
  let busy = false;
  let last = "";
  while (Date.now() - t0 < ms) {
    await sleep(POLL_MS);
    last = (await previewBranches(ctx, ref)).find((x) => x.git_branch === git)?.status ?? "absent";
    if (["CREATING_PROJECT", "RUNNING_MIGRATIONS", "MIGRATIONS_PASSED"].includes(last)) busy = true;
    if (busy && ["FUNCTIONS_DEPLOYED", "MIGRATIONS_FAILED", "FUNCTIONS_FAILED"].includes(last)) return last;
  }
  return `timeout:${last}`;
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
    if (!conns.rows.find((c) => c.project_ref === refs.a)?.supabase_changes_only) {
      return { id: ID, title: TITLE, status: "skip", detail: 'needs "Supabase changes only" on for A' };
    }
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const m: Record<string, string | number> = { poll_s: POLL_MS / 1000, phase_s: PHASE_MS / 1000 };
    const gits: string[] = [];
    const prs: number[] = [];

    // --- late: app-only open, then a migration pushed, then close + reopen.
    const lateGit = `gb05-${stamp}-late`;
    branchWithFiles(repo, "main", lateGit, { "apps/a/README.md": `# app a\n\nlate ${stamp}\n` }, "probe: app-only open");
    const latePr = openPr(repo, lateGit, "main", `GB05 late (${stamp})`);
    gits.push(lateGit);
    prs.push(latePr);
    const open = await watchPreview(ctx, refs.a, lateGit, 2 * 60_000);
    m.late_on_open = open.seenS >= 0 ? `yes@${open.seenS}s` : "no";
    pushCommit(repo, lateGit, { [`apps/a/supabase/migrations/${stamp}_late.sql`]: `alter table public.a_items add column if not exists late_${stamp} text;\n` }, "probe: migration pushed later");
    const afterPush = await watchPreview(ctx, refs.a, lateGit, PHASE_MS);
    m.late_after_push = afterPush.seenS >= 0 ? `yes@${afterPush.seenS}s` : "no";
    let reopen = afterPush;
    if (afterPush.seenS < 0) {
      closePr(repo, latePr);
      await sleep(15_000);
      ghApi("PATCH", `repos/${repo}/pulls/${latePr}`, { state: "open" });
      reopen = await watchPreview(ctx, refs.a, lateGit, PHASE_MS);
      m.late_after_reopen = reopen.seenS >= 0 ? `yes@${reopen.seenS}s` : "no";
    } else {
      m.late_after_reopen = "not needed";
    }
    ctx.log(`late: open ${m.late_on_open}, push ${m.late_after_push}, reopen ${m.late_after_reopen}`);

    // --- reseed: migration open (A previews), then a seed.sql change pushed.
    const seedGit = `gb05-${stamp}-reseed`;
    branchWithFiles(repo, "main", seedGit, { [`apps/a/supabase/migrations/${stamp}_seedbase.sql`]: `alter table public.a_items add column if not exists s_${stamp} text;\n` }, "probe: migration open");
    const seedPr = openPr(repo, seedGit, "main", `GB05 reseed (${stamp})`);
    gits.push(seedGit);
    prs.push(seedPr);
    const first = await waitSettled(ctx, refs.a, seedGit, 6 * 60_000);
    m.reseed_first_run = first;
    const preview = (await previewBranches(ctx, refs.a)).find((x) => x.git_branch === seedGit)?.project_ref ?? "";
    const label = `seedpush-${stamp}`;
    const seed = fileContent(repo, "apps/a/supabase/seed.sql");
    pushCommit(repo, seedGit, { "apps/a/supabase/seed.sql": `${seed}insert into public.a_items (label) values ('${label}');\n` }, "probe: seed change pushed");
    await sleep(PHASE_MS);
    let rows = -1;
    let err = "";
    if (preview) {
      const r = await sql({ ...ctx, ref: preview }, `select count(*)::int as n from public.a_items where label = '${label}'`);
      rows = Number((r.rows[0] as { n?: number })?.n ?? -1);
      err = r.error;
    }
    m.reseed_new_row_present = rows < 0 ? `unread${err ? `: ${err.slice(0, 60)}` : ""}` : String(rows > 0);
    ctx.log(`reseed: first run ${first}, new seed row present ${m.reseed_new_row_present}`);

    for (let i = 0; i < prs.length; i++) {
      closePr(repo, prs[i]!);
      deleteBranch(repo, gits[i]!);
    }
    await sleep(SETTLE_AFTER_CLOSE_MS);
    const set = new Set(gits);
    const leftovers = [...(await previewBranches(ctx, refs.a)), ...(await previewBranches(ctx, refs.b))].filter((b) => set.has(b.git_branch));
    for (const b of leftovers) await mgmt(ctx, "DELETE", `/branches/${b.id}`);
    m.leftover_after_close = leftovers.length;

    return {
      id: ID,
      title: TITLE,
      status: "info",
      detail: `late: on open ${m.late_on_open}; after migration pushed ${m.late_after_push}; after close+reopen ${m.late_after_reopen}. reseed: first run ${m.reseed_first_run}; seed row from a pushed seed.sql change present ${m.reseed_new_row_present}.`,
      measurements: m,
    };
  },
};
export default mod;
