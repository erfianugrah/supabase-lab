/**
 * GB04 - with "Supabase changes only" on, which kinds of file under
 * <workdir>/supabase/ trigger a preview, and what the integration writes on
 * the pull request.
 *
 * GB01 changed only migrations. A monorepo that seeds its previews also
 * changes seed.sql, config.toml and functions, so this module opens one pull
 * request per kind, all under apps/a/supabase/ (project A's workdir), all at
 * once:
 *
 *   a-seed      apps/a/supabase/seed.sql (a second insert)
 *   a-config    apps/a/supabase/config.toml (a comment line appended)
 *   a-function  apps/a/supabase/functions/probe/index.ts (new function)
 *   a-other     apps/a/supabase/NOTES.md (a file the CLI does not read)
 *
 * Per shape: a_branch / b_branch (preview created within the window, first
 * seen at the 30 s poll), and the pull request's issue comments - author
 * login and whether the body names project A's or B's ref - because a
 * comment that names the project is the one GitHub-side place a CI job
 * holding only GITHUB_TOKEN could tell the two projects apart.
 *
 * The toggle state is read at the start and must be on for both projects;
 * the module skips otherwise.
 *
 * DESTRUCTIVE: git branches, pull requests, billed preview branches. Cleanup
 * as GB01.
 *
 * Not settled by this module: whether a config.toml change that alters a
 * value behaves differently from a comment-only change; kinds under
 * supabase/ other than these four.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  branchWithFiles,
  closePr,
  connections,
  deleteBranch,
  ghApi,
  openPr,
  orgSlugOf,
  previewBranches,
  repoOf,
  sleep,
} from "../lib/gh.js";

const ID = "GB04";
const TITLE = "changes-only on: seed, config, function and other files under supabase/";
const WINDOW_MS = 10 * 60_000;
const POLL_MS = 30_000;
const SETTLE_AFTER_CLOSE_MS = 2 * 60_000;

function fileContent(repo: string, path: string): string {
  const r = ghApi("GET", `repos/${repo}/contents/${path}?ref=main`);
  const b64 = String((r.json as { content?: string })?.content ?? "");
  return Buffer.from(b64, "base64").toString("utf8");
}

interface Obs {
  git: string;
  pr: number;
  aSeenS: number;
  bSeenS: number;
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
    if (!ca?.supabase_changes_only || !cb?.supabase_changes_only) {
      return { id: ID, title: TITLE, status: "skip", detail: `needs "Supabase changes only" on for both (A=${ca?.supabase_changes_only}, B=${cb?.supabase_changes_only})` };
    }

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const seed = fileContent(repo, "apps/a/supabase/seed.sql");
    const config = fileContent(repo, "apps/a/supabase/config.toml");
    const shapes: Record<string, Record<string, string>> = {
      "a-seed": { "apps/a/supabase/seed.sql": `${seed}insert into public.a_items (label) values ('seed-${stamp}');\n` },
      "a-config": { "apps/a/supabase/config.toml": `${config}\n# probe ${stamp}\n` },
      "a-function": { "apps/a/supabase/functions/probe/index.ts": `Deno.serve(() => new Response("probe ${stamp}"));\n` },
      "a-other": { "apps/a/supabase/NOTES.md": `probe ${stamp}\n` },
    };

    const obs: Record<string, Obs> = {};
    const t0 = Date.now();
    for (const [shape, files] of Object.entries(shapes)) {
      const git = `gb04-${stamp}-${shape}`;
      branchWithFiles(repo, "main", git, files, `probe: ${shape}`);
      const pr = openPr(repo, git, "main", `GB04 ${shape} (${stamp})`);
      obs[shape] = { git, pr, aSeenS: -1, bSeenS: -1 };
      ctx.log(`${shape}: PR #${pr} on ${git}`);
    }

    while (Date.now() - t0 < WINDOW_MS) {
      await sleep(POLL_MS);
      const s = Math.round((Date.now() - t0) / 1000);
      const [ba, bb] = [await previewBranches(ctx, refs.a), await previewBranches(ctx, refs.b)];
      for (const o of Object.values(obs)) {
        if (o.aSeenS < 0 && ba.some((b) => b.git_branch === o.git)) o.aSeenS = s;
        if (o.bSeenS < 0 && bb.some((b) => b.git_branch === o.git)) o.bSeenS = s;
      }
    }

    // Comments, read before the preview projects go: a body may carry the
    // preview's ref as well as the parent's.
    const previewRefs = new Map<string, string>();
    for (const [role, ref] of [["A", refs.a], ["B", refs.b]] as const) {
      for (const b of await previewBranches(ctx, ref)) if (b.project_ref) previewRefs.set(b.project_ref, role);
    }
    const comments: Record<string, unknown[]> = {};
    for (const [shape, o] of Object.entries(obs)) {
      const r = ghApi("GET", `repos/${repo}/issues/${o.pr}/comments?per_page=50`);
      comments[shape] = ((r.json as Record<string, unknown>[]) ?? []).map((c) => {
        const body = String(c.body ?? "");
        const names = (ref: string) => Boolean(ref) && body.includes(ref);
        const preview = [...previewRefs.entries()].filter(([ref]) => body.includes(ref)).map(([, role]) => role);
        return {
          author: String((c.user as { login?: string })?.login ?? ""),
          author_type: String((c.user as { type?: string })?.type ?? ""),
          names_parent_a: names(refs.a),
          names_parent_b: names(refs.b),
          names_preview_of: preview.join("|"),
          length: body.length,
          // Body kept for the record; publish-evidence redacts refs and the
          // repository name.
          body,
        };
      });
    }

    for (const o of Object.values(obs)) {
      closePr(repo, o.pr);
      deleteBranch(repo, o.git);
    }
    await sleep(SETTLE_AFTER_CLOSE_MS);
    const gits = new Set(Object.values(obs).map((o) => o.git));
    const leftovers = [...(await previewBranches(ctx, refs.a)), ...(await previewBranches(ctx, refs.b))].filter((b) => gits.has(b.git_branch));
    for (const b of leftovers) await mgmt(ctx, "DELETE", `/branches/${b.id}`);

    const m: Record<string, string | number> = { toggle_changes_only: "A=true,B=true", window_s: WINDOW_MS / 1000 };
    const lines: string[] = [];
    for (const [shape, o] of Object.entries(obs)) {
      const cs = (comments[shape] ?? []) as { author_type: string; names_parent_a: boolean; names_parent_b: boolean; names_preview_of: string }[];
      m[`${shape}_a_branch`] = o.aSeenS >= 0 ? `yes@${o.aSeenS}s` : "no";
      m[`${shape}_b_branch`] = o.bSeenS >= 0 ? `yes@${o.bSeenS}s` : "no";
      m[`${shape}_comments`] = cs.length;
      m[`${shape}_comment_names`] = cs.map((c) => [c.names_parent_a ? "A" : "", c.names_parent_b ? "B" : "", c.names_preview_of ? `preview:${c.names_preview_of}` : ""].filter(Boolean).join("+") || "none").join("|") || "no comments";
      lines.push(`${shape}: A ${m[`${shape}_a_branch`]}, B ${m[`${shape}_b_branch`]}, ${cs.length} comment(s) naming ${m[`${shape}_comment_names`]}`);
    }
    m.leftover_after_close = leftovers.length;

    return {
      id: ID,
      title: TITLE,
      status: "info",
      detail: `${lines.join("; ")}. Previews left 2 min after close: ${leftovers.length}.`,
      measurements: m,
      evidence: JSON.stringify(comments, null, 2),
    };
  },
};
export default mod;
