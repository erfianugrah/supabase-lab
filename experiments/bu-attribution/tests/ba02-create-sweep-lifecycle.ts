/**
 * BA02 - the write path and the sweep, on one throwaway project.
 *
 * The customer-side pattern is: the provisioning service records
 * `ref -> unit` from the create response, and a sweep diffs the org's
 * project list against that map so nothing created any other way goes
 * unattributed. Both halves rest on platform behaviour measured here.
 *
 *   BA02a  create returns the ref synchronously in the 201 body, before the
 *          project is healthy - the write path can record attribution in
 *          the same request/response, with no polling.
 *   BA02b  sweep visibility: seconds from the 201 until the ref appears in
 *          GET /organizations/{slug}/projects (the sweep's source; pass
 *          gates on it). GET /projects is recorded alongside as evidence,
 *          not the gate.
 *          The org listing is paginated ({projects, pagination}); the
 *          page limit is recorded.
 *   BA02c  the unit-prefixed name survives verbatim in both listings.
 *   BA02d  rename via PATCH /projects/{ref}: if it succeeds, a name prefix
 *          is mutable and cannot be the attribution of record.
 *   BA02e  after DELETE, seconds until the ref leaves both listings. Once it
 *          is gone, the map row is the only record that it existed, which
 *          is why the map must never delete rows (M07: 29 of 32 invoice
 *          refs had been deleted before the invoice arrived).
 *   BA02f  the live project's key set (org listing + detail) carries no
 *          creator/tag/label/metadata field, so attribution must be written
 *          by the caller at create time.
 *
 * Deletes its project in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 2000;
const VISIBLE_MAX_MS = 120_000;
const GONE_MAX_MS = 600_000;
// Field names that would mean the platform records attribution itself.
const ATTRIBUTION_HINTS = /creat(or|ed_by)|owner|tag|label|metadata|annotation|user_id|token/i;

function refsOf(json: unknown): Map<string, string> {
  const arr = Array.isArray(json) ? json : ((json as { projects?: unknown[] } | undefined)?.projects ?? []);
  const out = new Map<string, string>();
  for (const p of arr as Array<{ ref?: string; id?: string; name?: string }>) {
    const ref = p.ref ?? p.id;
    if (ref) out.set(ref, p.name ?? "");
  }
  return out;
}

async function listings(ctx: Ctx, org: string) {
  const [all, byOrg] = await Promise.all([
    mgmt(ctx, "GET", "/projects"),
    mgmt(ctx, "GET", `/organizations/${org}/projects`),
  ]);
  const page = (byOrg.json as { pagination?: { limit?: number } } | undefined)?.pagination;
  return {
    all: refsOf(all.json),
    byOrg: refsOf(byOrg.json),
    orgStatus: byOrg.status,
    allCount: Array.isArray(all.json) ? all.json.length : -1,
    pageLimit: page?.limit ?? -1,
    orgRaw: byOrg.json,
  };
}

const mod: TestModule = {
  id: "BA02",
  title: "Create returns ref; sweep visibility, rename, delete",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    const ids = ["BA02a", "BA02b", "BA02c", "BA02d", "BA02e", "BA02f"] as const;
    const has = (id: string) => results.some((r) => r.id === id);
    let ref = "";
    let deleted = false;

    try {
      const t0 = Date.now();
      const name = `bu-alpha-ba02-${t0}`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });
      const createMs = Date.now() - t0;
      const body = (create.json as { ref?: string; id?: string; status?: string } | undefined) ?? {};
      ref = body.ref ?? body.id ?? "";
      results.push({
        id: "BA02a",
        title: "BA02a: create returns the ref synchronously",
        status: create.status === 201 && ref ? "pass" : "fail",
        detail: ref ? `status at create=${body.status ?? "?"}` : `HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        measurements: { create_status: create.status, create_ms: createMs },
      });
      if (!ref) return results;

      // ---- BA02b/c: visibility + name ----
      let seenAll = -1;
      let seenOrg = -1;
      let nameAll = "";
      let nameOrg = "";
      let orgStatus = 0;
      let allMax = 0;
      let pageLimit = -1;
      let orgEntry: Record<string, unknown> = {};
      while (Date.now() - t0 < VISIBLE_MAX_MS && (seenAll < 0 || seenOrg < 0)) {
        const l = await listings(ctx, org);
        orgStatus = l.orgStatus;
        allMax = Math.max(allMax, l.allCount);
        pageLimit = l.pageLimit;
        const arr = ((l.orgRaw as { projects?: Array<Record<string, unknown>> } | undefined)?.projects ?? []);
        orgEntry = arr.find((p) => (p.ref ?? p.id) === ref) ?? orgEntry;
        if (seenAll < 0 && l.all.has(ref)) {
          seenAll = Date.now() - t0;
          nameAll = l.all.get(ref) ?? "";
        }
        if (seenOrg < 0 && l.byOrg.has(ref)) {
          seenOrg = Date.now() - t0;
          nameOrg = l.byOrg.get(ref) ?? "";
        }
        if (seenAll < 0 || seenOrg < 0) await sleep(POLL_MS);
      }
      results.push({
        id: "BA02b",
        title: "BA02b: new ref visible to the org-listing sweep",
        status: seenOrg >= 0 ? "pass" : "fail",
        detail: seenAll < 0 ? `GET /projects never listed it (max length seen ${allMax})` : undefined,
        measurements: {
          visible_org_ms: seenOrg,
          visible_all_ms: seenAll,
          all_max_len: allMax,
          org_page_limit: pageLimit,
          org_projects_status: orgStatus,
        },
      });
      results.push({
        id: "BA02c",
        title: "BA02c: unit-prefixed name survives in the org listing",
        status: nameOrg === name ? "pass" : "fail",
        detail: `org=${nameOrg || "-"} all=${nameAll || "-"}`,
      });

      // ---- BA02f: key set while the project is live ----
      const detail = await mgmt(ctx, "GET", `/projects/${ref}`);
      const listKeys = Object.keys(orgEntry);
      const detailKeys = Object.keys((detail.json as Record<string, unknown> | undefined) ?? {});
      const hints = [...new Set([...listKeys, ...detailKeys])].filter((k) => ATTRIBUTION_HINTS.test(k));
      results.push({
        id: "BA02f",
        title: "BA02f: project object carries no attribution field",
        status: hints.length === 0 ? "pass" : "info",
        detail: hints.length === 0 ? "no creator/tag/label/metadata field" : `candidate fields: ${hints.join(",")}`,
        measurements: { list_keys: listKeys.length, detail_keys: detailKeys.length },
        evidence: `list: ${listKeys.join(",")} | detail: ${detailKeys.join(",")}`,
      });

      // ---- BA02d: rename ----
      const renamed = `bu-beta-ba02-${t0}`;
      const patch = await mgmt(ctx, "PATCH", `/projects/${ref}`, { name: renamed });
      const after = await mgmt(ctx, "GET", `/projects/${ref}`);
      const nameAfter = String((after.json as { name?: string } | undefined)?.name ?? "");
      results.push({
        id: "BA02d",
        title: "BA02d: project name is mutable after create",
        status: "info",
        detail: nameAfter === renamed ? "MUTABLE - name cannot be the attribution of record" : `name unchanged (${nameAfter})`,
        measurements: { patch_status: patch.status, renamed: nameAfter === renamed ? 1 : 0 },
        evidence: `keys: ${Object.keys((patch.json as Record<string, unknown> | undefined) ?? {}).join(",")}`,
      });

      // ---- BA02e: delete -> gone ----
      const td = Date.now();
      const del = await mgmt(ctx, "DELETE", `/projects/${ref}`);
      deleted = del.status >= 200 && del.status < 300;
      let goneAll = -1;
      let goneOrg = -1;
      while (deleted && Date.now() - td < GONE_MAX_MS && (goneAll < 0 || goneOrg < 0)) {
        const l = await listings(ctx, org);
        if (goneAll < 0 && !l.all.has(ref)) goneAll = Date.now() - td;
        if (goneOrg < 0 && !l.byOrg.has(ref)) goneOrg = Date.now() - td;
        if (goneAll < 0 || goneOrg < 0) await sleep(POLL_MS * 5);
      }
      results.push({
        id: "BA02e",
        title: "BA02e: deleted ref leaves the listings",
        status: deleted && goneAll >= 0 && goneOrg >= 0 ? "pass" : "fail",
        detail: deleted ? undefined : `DELETE HTTP ${del.status}: ${del.text.slice(0, 200)}`,
        measurements: { delete_status: del.status, gone_all_ms: goneAll, gone_org_ms: goneOrg },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      if (ref && !deleted) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    for (const id of ids) if (!has(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
