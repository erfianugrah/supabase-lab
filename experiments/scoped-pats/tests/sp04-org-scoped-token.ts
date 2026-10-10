/**
 * SP04 - an org-scoped PAT on production (Q14 / Task 5b of the
 * bu-attribution plan): does it create projects, does it see projects created
 * later, what can it read outside the org listing, and does it draw on the
 * same request budget as the owner's lab token?
 *
 * Token: PVLAB_SCOPED_PAT_ORG, created in the dashboard (creation has no API,
 * SP01). Resources: the Pro org only, all projects. Permissions: Organization
 * Projects = Read-write. Org slug: PVLAB_ORG_PRO.
 *
 *   SP04a  control: lab token reads the org; the scoped token's view of the
 *          same org listing (status, count) and of the account-level reads
 *          (`/profile`, `/organizations`, `/projects`, `/snippets`).
 *   SP04b  create: POST /projects with the scoped token (status, ms to the
 *          ref). The scoped token then lists, reads and tries to delete it.
 *   SP04c  later project: the lab token creates a second project AFTER the
 *          token exists; seconds until the scoped listing includes it and
 *          whether `GET /projects/{ref}` answers for it.
 *   SP04d  request budget: interleaved reads of the SAME route, lab token and
 *          scoped token, recording x-ratelimit-remaining from each. The docs
 *          scope the limit per endpoint and SP10 is consistent with that, so
 *          the comparison is only valid on one route. A counter shared between the tokens makes
 *          every reading lower than the last reading of either token; two
 *          counters make the scoped sequence fall by exactly 1 per scoped call.
 *
 * Every project created here is deleted with the lab token in `finally`.
 * Only statuses, counts, seconds and header values are recorded.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, scrub, sleep, type Resp } from "../lib/http.js";
import { createProject, deleteProject } from "../lib/fixture.js";
import { ROLES, skipReason, tokenFor } from "../lib/tokens.js";

const IDS = ["SP04a", "SP04b", "SP04c", "SP04d"] as const;
const role = ROLES.find((r) => r.role === "org")!;

const refsOf = (j: unknown): string[] => {
  const arr = Array.isArray(j) ? j : ((j as { projects?: unknown[] } | undefined)?.projects ?? []);
  return (arr as Array<{ ref?: string; id?: string }>).map((p) => p.ref ?? p.id ?? "").filter(Boolean);
};
const hdr = (r: Resp, k: string) => r.headers.get(k) ?? "absent";

async function pollListed(token: string, slug: string, ref: string, maxS = 90): Promise<number | "never"> {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < maxS) {
    const l = await call(token, "GET", `/organizations/${slug}/projects`);
    if (refsOf(l.json).includes(ref)) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(8_000);
  }
  return "never";
}

const mod: TestModule = {
  id: "SP04",
  title: "Org-scoped PAT: create, later projects, account-level reads, request budget",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const tok = tokenFor(role);
    const slug = ctx.orgs.pro ?? "";
    if (!tok || !slug) {
      const why = !tok ? skipReason(role) : "PVLAB_ORG_PRO not set";
      return IDS.map((id) => ({ id, title: id, status: "skip" as const, detail: why }));
    }
    const pat = ctx.pat ?? "";
    const results: TestResult[] = [];
    const has = (id: string) => results.some((r) => r.id === id);
    const cleanup: string[] = [];

    try {
      // ---- SP04a ----
      const ctlOrg = await call(pat, "GET", `/organizations/${slug}`);
      const ownerList = await call(pat, "GET", `/organizations/${slug}/projects`);
      const scList = await call(tok, "GET", `/organizations/${slug}/projects`);
      const scOrg = await call(tok, "GET", `/organizations/${slug}`);
      const scProfile = await call(tok, "GET", "/profile");
      const scOrgs = await call(tok, "GET", "/organizations");
      const scProjects = await call(tok, "GET", "/projects");
      const scSnippets = await call(tok, "GET", "/snippets");
      results.push({
        id: "SP04a",
        title: "SP04a: what an Organization Projects read-write token reads",
        status: ctlOrg.status === 200 ? "info" : "skip",
        detail: ctlOrg.status === 200 ? undefined : `control GET org HTTP ${ctlOrg.status}`,
        measurements: {
          owner_org_listing_count: refsOf(ownerList.json).length,
          scoped_org_listing_status: scList.status,
          scoped_org_listing_count: refsOf(scList.json).length,
          scoped_org_detail_status: scOrg.status,
          scoped_profile_status: scProfile.status,
          scoped_organizations_status: scOrgs.status,
          scoped_projects_status: scProjects.status,
          scoped_projects_count: refsOf(scProjects.json).length,
          scoped_snippets_status: scSnippets.status,
        },
        // Bodies of the account-level reads carry org names and SQL snippet
        // titles; only the profile refusal text is kept.
        evidence: `profile: ${scrub(scProfile.text)}`,
      });

      // ---- SP04b ----
      const created = await createProject(ctx, slug, "sp04-scoped", tok);
      if (created.ref) cleanup.push(created.ref);
      let listedS: number | "never" | "n/a" = "n/a";
      let getStatus: number | "n/a" = "n/a";
      let delStatus: number | "n/a" = "n/a";
      if (created.ref) {
        listedS = await pollListed(tok, slug, created.ref);
        getStatus = (await call(tok, "GET", `/projects/${created.ref}`)).status;
        const d = await call(tok, "DELETE", `/projects/${created.ref}`);
        delStatus = d.status;
        if (d.status >= 200 && d.status < 300) cleanup.splice(cleanup.indexOf(created.ref), 1);
      }
      results.push({
        id: "SP04b",
        title: "SP04b: the scoped token creates, then lists, reads and deletes its own project",
        status: "info",
        detail: created.ref ? undefined : `create refused: ${scrub(created.text)}`,
        measurements: {
          create_status: created.status,
          create_ms: created.ms,
          seconds_until_scoped_listing_has_it: listedS,
          scoped_get_status: getStatus,
          scoped_delete_status: delStatus,
        },
      });

      // ---- SP04c ----
      const later = await createProject(ctx, slug, "sp04-later");
      if (later.ref) cleanup.push(later.ref);
      let laterListed: number | "never" | "n/a" = "n/a";
      let laterGet: number | "n/a" = "n/a";
      if (later.ref) {
        laterListed = await pollListed(tok, slug, later.ref);
        laterGet = (await call(tok, "GET", `/projects/${later.ref}`)).status;
      }
      results.push({
        id: "SP04c",
        title: "SP04c: a project the lab token creates after the token exists",
        status: later.ref ? "info" : "fail",
        detail: later.ref ? undefined : `lab-token create HTTP ${later.status}`,
        measurements: {
          lab_create_status: later.status,
          seconds_until_scoped_listing_has_it: laterListed,
          scoped_get_status: laterGet,
        },
      });

      // ---- SP04d ----
      const seqC: string[] = [];
      const seqS: string[] = [];
      let lim = "absent";
      for (let i = 0; i < 4; i++) {
        const c = await call(pat, "GET", `/organizations/${slug}/projects`);
        const s = await call(tok, "GET", `/organizations/${slug}/projects`);
        seqC.push(hdr(c, "x-ratelimit-remaining"));
        seqS.push(hdr(s, "x-ratelimit-remaining"));
        lim = `${hdr(c, "x-ratelimit-limit")}/${hdr(s, "x-ratelimit-limit")}`;
      }
      results.push({
        id: "SP04d",
        title: "SP04d: x-ratelimit-remaining, lab and scoped reads interleaved",
        status: "info",
        detail: "other callers on the same user inflate every drop; read the scoped sequence against its own call count",
        measurements: {
          limit_lab_over_scoped: lim,
          lab_remaining_seq: seqC.join(","),
          scoped_remaining_seq: seqS.join(","),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of IDS) if (!has(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      for (const ref of cleanup) await deleteProject(ctx, ref).catch(() => 0);
    }
    for (const id of IDS) if (!has(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
