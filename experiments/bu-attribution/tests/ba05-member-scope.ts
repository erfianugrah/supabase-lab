/**
 * BA05 - what a restricted org member can actually do.
 *
 * The single-org pattern relies on two things the entitlements read (BA01a)
 * cannot prove: that a unit's people cannot create projects outside the
 * provisioning path, and that a project-scoped member cannot see other
 * units' projects. Role assignment has no Management API surface on this
 * plan (`api.members.roles: false`; the v2 role endpoints are
 * Enterprise-only by default per the spec), so the operator assigns the role in the
 * dashboard and this module measures it with the MEMBER's token.
 *
 * Inputs:
 *   SUPABASE_ACCESS_TOKEN   owner token (ctx.pat) - setup/cleanup only
 *   PVLAB_PAT2              the restricted member's token
 *   PVLAB_PEER_INSCOPE      a project the member is scoped to (optional for
 *                           an org-wide role)
 *   PVLAB_PEER_OUTSCOPE     a project the member is NOT scoped to
 * Run once per role under test; the member's role is read from the owner's
 * member listing and recorded, so each run labels itself.
 *
 *   BA05-control  member token valid; member's role as the owner sees it.
 *   BA05a         member POST /projects in the org: allowed or refused.
 *   BA05b         member's view of GET /organizations/{slug}/projects:
 *                 count, in-scope listed, out-of-scope listed.
 *   BA05c         member GET /projects/{ref}: in-scope vs out-of-scope.
 *   BA05d         member GET /projects/{out}/api-keys (no reveal): can a
 *                 unit read another unit's key metadata. Status only.
 *   BA05e         future projects: owner creates a project now; can the
 *                 member see it (org-wide roles should, scoped should not).
 *
 * Any project created here (BA05a if allowed, BA05e) is deleted with the
 * owner token in `finally`. Only statuses, counts and role names are
 * recorded - no refs, no key material.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

function refsOf(json: unknown): string[] {
  const arr = Array.isArray(json) ? json : ((json as { projects?: unknown[] } | undefined)?.projects ?? []);
  return (arr as Array<{ ref?: string; id?: string }>).map((p) => p.ref ?? p.id ?? "").filter(Boolean);
}

interface Member {
  user_id?: string;
  user_name?: string;
  email?: string;
  role_name?: string;
  [k: string]: unknown;
}

const mod: TestModule = {
  id: "BA05",
  title: "Restricted member: create, visibility, future projects",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    const ids = ["BA05-control", "BA05a", "BA05b", "BA05c", "BA05d", "BA05e"] as const;
    const has = (id: string) => results.some((r) => r.id === id);
    const pat2 = process.env.PVLAB_PAT2 ?? "";
    if (!pat2) {
      return ids.map((id) => ({ id, title: id, status: "skip" as const, detail: "PVLAB_PAT2 (restricted member token) not set" }));
    }
    const member: Ctx = { ...ctx, pat: pat2 };
    const inScope = ctx.peers.inscope ?? "";
    const outScope = ctx.peers.outscope ?? "";
    const cleanup: string[] = [];

    try {
      // ---- BA05-control: member identity + role ----
      const prof = await mgmt(member, "GET", "/profile");
      const p = (prof.json as { gotrue_id?: string; primary_email?: string; username?: string } | undefined) ?? {};
      const ml = await mgmt(ctx, "GET", `/organizations/${org}/members`);
      const members = (Array.isArray(ml.json) ? ml.json : []) as Member[];
      const me = members.find(
        (m) => (p.gotrue_id && m.user_id === p.gotrue_id) || (p.primary_email && m.email === p.primary_email),
      );
      const scopeKeys = me ? Object.keys(me).filter((k) => /project|scope/i.test(k)) : [];
      results.push({
        id: "BA05-control",
        title: "BA05-control: member token valid, role as the owner sees it",
        status: prof.status === 200 && me ? "pass" : "fail",
        detail: me ? `role=${me.role_name ?? "?"}` : `profile HTTP ${prof.status}; member not found in org listing (HTTP ${ml.status})`,
        measurements: { profile_status: prof.status, members_status: ml.status, role: String(me?.role_name ?? "") },
        evidence: me ? `member keys: ${Object.keys(me).join(",")}; scope fields: ${scopeKeys.map((k) => `${k}=${JSON.stringify(me[k])}`).join(" ").replace(/[a-z]{20}/g, "<ref>")}` : undefined,
      });
      if (!me) return results;

      // ---- BA05a: member create ----
      const t0 = Date.now();
      const create = await mgmt(member, "POST", "/projects", {
        organization_slug: org,
        name: `bu-member-ba05-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });
      const createdRef = (create.json as { ref?: string } | undefined)?.ref ?? "";
      if (createdRef) cleanup.push(createdRef);
      results.push({
        id: "BA05a",
        title: "BA05a: member can create a project in the org",
        status: "info",
        detail: createdRef ? "ALLOWED - this role bypasses the provisioning path" : "REFUSED",
        measurements: { create_status: create.status },
        evidence: createdRef ? undefined : create.text.slice(0, 200),
      });

      // ---- BA05b: member's org listing ----
      const lst = await mgmt(member, "GET", `/organizations/${org}/projects`);
      const seen = refsOf(lst.json);
      const ownerSeen = refsOf((await mgmt(ctx, "GET", `/organizations/${org}/projects`)).json);
      results.push({
        id: "BA05b",
        title: "BA05b: member's view of the org project listing",
        status: "info",
        measurements: {
          list_status: lst.status,
          member_count: seen.length,
          owner_count: ownerSeen.length,
          inscope_listed: inScope ? (seen.includes(inScope) ? 1 : 0) : "n/a",
          outscope_listed: outScope ? (seen.includes(outScope) ? 1 : 0) : "n/a",
        },
      });

      // ---- BA05c / BA05d: direct reads ----
      const gIn = inScope ? (await mgmt(member, "GET", `/projects/${inScope}`)).status : "n/a";
      const gOut = outScope ? (await mgmt(member, "GET", `/projects/${outScope}`)).status : "n/a";
      results.push({
        id: "BA05c",
        title: "BA05c: member reads a project directly (in vs out of scope)",
        status: outScope ? "info" : "skip",
        detail: outScope ? undefined : "PVLAB_PEER_OUTSCOPE not set",
        measurements: { inscope_status: gIn, outscope_status: gOut },
      });
      const kOut = outScope ? (await mgmt(member, "GET", `/projects/${outScope}/api-keys`)).status : "n/a";
      results.push({
        id: "BA05d",
        title: "BA05d: member reads another project's api-keys (no reveal)",
        status: outScope ? "info" : "skip",
        detail: outScope ? undefined : "PVLAB_PEER_OUTSCOPE not set",
        measurements: { outscope_api_keys_status: kOut },
      });

      // ---- BA05e: future project ----
      const fut = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `bu-owner-ba05-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });
      const futRef = (fut.json as { ref?: string } | undefined)?.ref ?? "";
      if (futRef) cleanup.push(futRef);
      let futStatus: number | string = "n/a";
      let futListed: number | string = "n/a";
      if (futRef) {
        // Visibility to the owner took ~6 s on the first BA02 run; give it the same slack.
        await new Promise((r) => setTimeout(r, 10_000));
        futStatus = (await mgmt(member, "GET", `/projects/${futRef}`)).status;
        futListed = refsOf((await mgmt(member, "GET", `/organizations/${org}/projects`)).json).includes(futRef) ? 1 : 0;
      }
      results.push({
        id: "BA05e",
        title: "BA05e: member sees a project created after the role was assigned",
        status: futRef ? "info" : "fail",
        detail: futRef ? undefined : `owner create HTTP ${fut.status}`,
        measurements: { future_get_status: futStatus, future_listed: futListed },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      for (const ref of cleanup) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
