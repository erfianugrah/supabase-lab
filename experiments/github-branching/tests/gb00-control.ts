/**
 * GB00 - control: both projects healthy, both connected to the one repository,
 * and the connection settings this run measured.
 *
 *   GB00  per project (A = ctx.ref, B = ctx.peers.b): status, GitHub
 *         connection present, repository, workdir, "Supabase changes only",
 *         "Automatic branching", branch limit - read from the public
 *         GET /v2/organizations/{slug}/integrations/github/connections
 *
 * GB01's results only mean something next to the toggle state they ran under,
 * so this module is the label. A red GB00 (a project unconnected, both
 * pointing at the same workdir, or the two connections on different
 * repositories or not on REPO) invalidates the run.
 *
 * Not settled by this module: whether the dashboard fields map one-to-one to
 * the v2 attributes. Three names correspond to the form's labels (Working
 * directory, Supabase changes only, Branch limit); Automatic branching is read
 * as `new_branch_per_pr`, assumed, not verified.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { connections, orgSlugOf, repoOf } from "../lib/gh.js";

const ID = "GB00";
const TITLE = "control: two projects, one repository, one workdir each";

const mod: TestModule = {
  id: ID,
  title: TITLE,
  where: "local",
  requires: ["pat", "peer"],
  async run(ctx: Ctx): Promise<TestResult> {
    const refs = { a: ctx.ref, b: ctx.peers.b ?? "" };
    const status: Record<string, string> = {};
    for (const [k, ref] of Object.entries(refs)) {
      const p = await mgmt(ctx, "GET", `/projects/${ref}`);
      status[k] = String((p.json as { status?: string })?.status ?? p.status);
    }
    const slug = await orgSlugOf(ctx, refs.a);
    const conns = await connections(ctx, slug);
    const byRef = (ref: string) => conns.rows.find((c) => c.project_ref === ref);
    const ca = byRef(refs.a);
    const cb = byRef(refs.b);
    const repo = repoOf(ctx);
    const repoName = repo.split("/").pop() ?? "";
    const sameRepo = Boolean(ca && cb && ca.repository === cb.repository && (!repoName || ca.repository.endsWith(repoName)));
    const distinctWorkdir = Boolean(ca && cb && ca.workdir !== cb.workdir);
    const ok = status.a === "ACTIVE_HEALTHY" && status.b === "ACTIVE_HEALTHY" && sameRepo && distinctWorkdir;
    const fmt = (c?: typeof ca) =>
      c ? `workdir=${c.workdir} changes_only=${c.supabase_changes_only} auto_branching=${c.new_branch_per_pr} limit=${c.branch_limit}` : "NOT CONNECTED";
    return {
      id: ID,
      title: TITLE,
      status: ok ? "pass" : "fail",
      detail: `v2 connections ${conns.status}. A: ${status.a}, ${fmt(ca)}. B: ${status.b}, ${fmt(cb)}. Same repository: ${sameRepo}.`,
      measurements: {
        connections_status: conns.status,
        a_status: status.a ?? "",
        b_status: status.b ?? "",
        a_workdir: ca?.workdir ?? "",
        b_workdir: cb?.workdir ?? "",
        a_changes_only: String(ca?.supabase_changes_only ?? ""),
        b_changes_only: String(cb?.supabase_changes_only ?? ""),
        a_auto_branching: String(ca?.new_branch_per_pr ?? ""),
        b_auto_branching: String(cb?.new_branch_per_pr ?? ""),
        same_repository: String(sameRepo),
      },
    };
  },
};
export default mod;
