/**
 * GitHub and branching helpers for the github-branching experiment.
 *
 * GitHub calls go through the `gh` CLI so the run uses whatever account the
 * operator is logged in as; no GitHub token passes through the harness. The
 * repository is `ctx.endpoints.repo` (`owner/name`, from PVLAB_ENDPOINT_REPO).
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const V2_BASE = "https://api.supabase.com/v2";

export interface GhResult {
  ok: boolean;
  status: number;
  json: unknown;
  stderr: string;
}

/** `gh api` with an optional JSON body on stdin. */
export function ghApi(method: string, path: string, body?: unknown): GhResult {
  const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", "-i", path];
  if (body !== undefined) args.push("--input", "-");
  const p = Bun.spawnSync(["gh", ...args], {
    stdin: body !== undefined ? new TextEncoder().encode(JSON.stringify(body)) : undefined,
  });
  const out = p.stdout.toString();
  // -i puts the status line and headers before a blank line, then the body.
  const split = out.indexOf("\r\n\r\n") >= 0 ? out.indexOf("\r\n\r\n") : out.indexOf("\n\n");
  const head = split >= 0 ? out.slice(0, split) : out;
  const text = split >= 0 ? out.slice(split).trim() : "";
  const status = Number(/HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { ok: status >= 200 && status < 300, status, json, stderr: p.stderr.toString().trim() };
}

export function repoOf(ctx: Ctx): string {
  return ctx.endpoints.repo ?? "";
}

/** Head commit of a git branch, or "" when it does not exist. */
export function headSha(repo: string, branch: string): string {
  const r = ghApi("GET", `repos/${repo}/git/ref/heads/${branch}`);
  return r.ok ? String((r.json as { object?: { sha?: string } }).object?.sha ?? "") : "";
}

/**
 * Create `branch` off `base` with one commit that writes each file in `files`.
 * One commit per branch, so the pull request's diff is exactly `files`.
 */
export function branchWithFiles(repo: string, base: string, branch: string, files: Record<string, string>, message: string): string {
  const baseSha = headSha(repo, base);
  if (!baseSha) throw new Error(`base branch ${base} not found`);
  const baseCommit = ghApi("GET", `repos/${repo}/git/commits/${baseSha}`).json as { tree: { sha: string } };
  const tree = ghApi("POST", `repos/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  if (!tree.ok) throw new Error(`tree: ${tree.status} ${JSON.stringify(tree.json).slice(0, 200)}`);
  const commit = ghApi("POST", `repos/${repo}/git/commits`, {
    message,
    tree: (tree.json as { sha: string }).sha,
    parents: [baseSha],
  });
  if (!commit.ok) throw new Error(`commit: ${commit.status}`);
  const sha = (commit.json as { sha: string }).sha;
  const ref = ghApi("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (!ref.ok) throw new Error(`ref: ${ref.status} ${JSON.stringify(ref.json).slice(0, 200)}`);
  return sha;
}

export function openPr(repo: string, head: string, base: string, title: string): number {
  const r = ghApi("POST", `repos/${repo}/pulls`, { head, base, title, body: "github-branching probe; closed by the run." });
  if (!r.ok) throw new Error(`pull: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return (r.json as { number: number }).number;
}

export function closePr(repo: string, n: number): boolean {
  return ghApi("PATCH", `repos/${repo}/pulls/${n}`, { state: "closed" }).ok;
}

export function deleteBranch(repo: string, branch: string): boolean {
  return ghApi("DELETE", `repos/${repo}/git/refs/heads/${branch}`).ok;
}

export interface CheckRun {
  id: number;
  name: string;
  app: string;
  status: string;
  conclusion: string;
  external_id: string;
  details_url: string;
  title: string;
  summary: string;
  started_at: string;
  suite: number;
}

/**
 * Every check-run on `sha`. `filter=all` matters: the endpoint's default is
 * `latest`, one run per check NAME, and every run the integration posts is
 * named "Supabase Preview" - the default view hid all but one of ten runs on
 * a commit both projects branched (2026-09-23).
 */
export function checkRuns(repo: string, sha: string, filter: "all" | "latest" = "all"): CheckRun[] {
  const r = ghApi("GET", `repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=${filter}`);
  const runs = ((r.json as { check_runs?: unknown[] })?.check_runs ?? []) as Record<string, unknown>[];
  return runs.map((c) => ({
    id: Number(c.id ?? 0),
    name: String(c.name ?? ""),
    app: String((c.app as { slug?: string })?.slug ?? ""),
    status: String(c.status ?? ""),
    conclusion: String(c.conclusion ?? ""),
    external_id: String(c.external_id ?? ""),
    details_url: String(c.details_url ?? ""),
    title: String((c.output as { title?: string })?.title ?? ""),
    summary: String((c.output as { summary?: string })?.summary ?? ""),
    started_at: String(c.started_at ?? ""),
    suite: Number((c.check_suite as { id?: number })?.id ?? 0),
  }));
}

/** Commit statuses (the older API), in case the integration reports there too. */
export function commitStatuses(repo: string, sha: string): { context: string; state: string; target_url: string }[] {
  const r = ghApi("GET", `repos/${repo}/commits/${sha}/statuses?per_page=100`);
  return ((r.json as Record<string, unknown>[]) ?? []).map((s) => ({
    context: String(s.context ?? ""),
    state: String(s.state ?? ""),
    target_url: String(s.target_url ?? ""),
  }));
}

export interface PreviewBranch {
  id: string;
  name: string;
  git_branch: string;
  pr_number: number | null;
  status: string;
  project_ref: string;
  is_default: boolean;
}

export async function previewBranches(ctx: Ctx, ref: string): Promise<PreviewBranch[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/branches`);
  if (r.status !== 200 || !Array.isArray(r.json)) return [];
  return (r.json as Record<string, unknown>[]).map((b) => ({
    id: String(b.id ?? ""),
    name: String(b.name ?? ""),
    git_branch: String(b.git_branch ?? ""),
    pr_number: typeof b.pr_number === "number" ? b.pr_number : null,
    status: String(b.status ?? ""),
    project_ref: String(b.project_ref ?? ""),
    is_default: Boolean(b.is_default),
  }));
}

export interface Connection {
  project_ref: string;
  repository: string;
  workdir: string;
  supabase_changes_only: boolean;
  new_branch_per_pr: boolean;
  branch_limit: number;
}

/** The org's GitHub connections from the public v2 endpoint. */
export async function connections(ctx: Ctx, orgSlug: string): Promise<{ status: number; rows: Connection[] }> {
  const res = await fetch(`${V2_BASE}/organizations/${orgSlug}/integrations/github/connections`, {
    headers: { Authorization: `Bearer ${ctx.pat}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { attributes: Record<string, unknown> }[] };
  const rows = (body.data ?? []).map(({ attributes: a }) => ({
    project_ref: String((a.project as { ref?: string })?.ref ?? ""),
    repository: String((a.repository as { name?: string })?.name ?? ""),
    workdir: String(a.workdir ?? ""),
    supabase_changes_only: Boolean(a.supabase_changes_only),
    new_branch_per_pr: Boolean(a.new_branch_per_pr),
    branch_limit: Number(a.branch_limit ?? 0),
  }));
  return { status: res.status, rows };
}

export async function orgSlugOf(ctx: Ctx, ref: string): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}`);
  const j = r.json as { organization_slug?: string; organization_id?: string } | undefined;
  return String(j?.organization_slug ?? j?.organization_id ?? "");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `?check_name=` with the endpoint's default filter - the view a wait-by-name action reads. */
export function checkRunsNamed(repo: string, sha: string, name: string): CheckRun[] {
  const r = ghApi("GET", `repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}`);
  const runs = ((r.json as { check_runs?: unknown[] })?.check_runs ?? []) as Record<string, unknown>[];
  return runs.map((c) => ({
    id: Number(c.id ?? 0),
    name: String(c.name ?? ""),
    app: String((c.app as { slug?: string })?.slug ?? ""),
    status: String(c.status ?? ""),
    conclusion: String(c.conclusion ?? ""),
    external_id: String(c.external_id ?? ""),
    details_url: String(c.details_url ?? ""),
    title: String((c.output as { title?: string })?.title ?? ""),
    summary: String((c.output as { summary?: string })?.summary ?? ""),
    started_at: String(c.started_at ?? ""),
    suite: Number((c.check_suite as { id?: number })?.id ?? 0),
  }));
}

export interface ActionRun {
  id: string;
  branch_id: string;
  check_run_id: number | null;
  workdir: string;
  steps: string;
  created_at: string;
}

/** A project's action runs (the branching pipeline), each carrying the GitHub check-run id it reports to. */
export async function actionRuns(ctx: Ctx, ref: string): Promise<ActionRun[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/actions`);
  if (r.status !== 200 || !Array.isArray(r.json)) return [];
  return (r.json as Record<string, unknown>[]).map((a) => ({
    id: String(a.id ?? ""),
    branch_id: String(a.branch_id ?? ""),
    check_run_id: typeof a.check_run_id === "number" ? a.check_run_id : null,
    workdir: String(a.workdir ?? ""),
    steps: ((a.run_steps as { name: string; status: string }[]) ?? []).map((s) => `${s.name}:${s.status}`).join(","),
    created_at: String(a.created_at ?? ""),
  }));
}

/** Create or update one file on a branch via the contents API. */
export function putFile(repo: string, branch: string, path: string, content: string, message: string): boolean {
  const cur = ghApi("GET", `repos/${repo}/contents/${path}?ref=${branch}`);
  const sha = cur.ok ? String((cur.json as { sha?: string }).sha ?? "") : undefined;
  return ghApi("PUT", `repos/${repo}/contents/${path}`, {
    message,
    branch,
    content: Buffer.from(content).toString("base64"),
    ...(sha ? { sha } : {}),
  }).ok;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string;
}

/** Workflow runs for a head sha, with their jobs. */
export function workflowRuns(repo: string, sha: string): { id: number; status: string; conclusion: string; jobs: WorkflowJob[] }[] {
  const r = ghApi("GET", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`);
  const runs = ((r.json as { workflow_runs?: Record<string, unknown>[] })?.workflow_runs ?? []);
  return runs.map((w) => {
    const j = ghApi("GET", `repos/${repo}/actions/runs/${w.id}/jobs`);
    const jobs = ((j.json as { jobs?: Record<string, unknown>[] })?.jobs ?? []).map((x) => ({
      name: String(x.name ?? ""),
      status: String(x.status ?? ""),
      conclusion: String(x.conclusion ?? ""),
    }));
    return { id: Number(w.id), status: String(w.status ?? ""), conclusion: String(w.conclusion ?? ""), jobs };
  });
}

/** The check-run id and conclusion the wait action logged ("Found a completed check with id N and conclusion X"). */
export function waitActionPick(repo: string, runId: number): { id: number; conclusion: string } | null {
  const p = Bun.spawnSync(["gh", "run", "view", String(runId), "-R", repo, "--log"]);
  const m = /Found a completed check with id (\d+) and conclusion (\w+)/.exec(p.stdout.toString());
  return m ? { id: Number(m[1]), conclusion: String(m[2]) } : null;
}
