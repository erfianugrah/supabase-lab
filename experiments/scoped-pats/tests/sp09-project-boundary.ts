/**
 * SP09 - the project boundary of a project-scoped token.
 *
 * Token: PVLAB_SCOPED_PAT_RO (selected project = the fixture only).
 * Projects: PVLAB_PEER_FIXTURE (in scope) and PVLAB_PEER_OTHER (a second
 * project in the same org, NOT selected). Org slug: PVLAB_ORG_PRO.
 *
 *   SP09a  direct reads: GET /projects/{in} and /projects/{out}, plus the out
 *          project's `api-keys` (no reveal) and `health`; status and, for a
 *          403, whether the body carries `missing_permissions`.
 *   SP09b  listings: does `GET /organizations/{slug}/projects` and
 *          `GET /projects` show the in-scope project, the out-of-scope one,
 *          how many entries each returns.
 *   SP09c  a project the lab token creates after the token exists: seconds
 *          until it appears in the scoped listing (60 s cap) and the status of
 *          a direct read. Created in the Pro org, deleted in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, denial, scrub, sleep } from "../lib/http.js";
import { createProject, deleteProject } from "../lib/fixture.js";
import { roleOf, skipReason, tokenFor } from "../lib/tokens.js";

const role = roleOf("ro");
const IDS = ["SP09a", "SP09b", "SP09c"] as const;
const refsOf = (j: unknown): string[] => {
  const arr = Array.isArray(j) ? j : ((j as { projects?: unknown[] } | undefined)?.projects ?? []);
  return (arr as Array<{ ref?: string; id?: string }>).map((p) => p.ref ?? p.id ?? "").filter(Boolean);
};

const mod: TestModule = {
  id: "SP09",
  title: "Project-scoped token: in-scope vs out-of-scope reads, listings, later projects",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const tok = tokenFor(role);
    const inRef = ctx.peers.fixture ?? "";
    const outRef = ctx.peers.other ?? "";
    const slug = ctx.orgs.pro ?? "";
    if (!tok || !inRef || !outRef || !slug) {
      const why = !tok
        ? skipReason(role)
        : "PVLAB_PEER_FIXTURE, PVLAB_PEER_OTHER and PVLAB_ORG_PRO are all required";
      return IDS.map((id) => ({ id, title: id, status: "skip" as const, detail: why }));
    }
    const results: TestResult[] = [];
    const cleanup: string[] = [];
    try {
      const gIn = await call(tok, "GET", `/projects/${inRef}`);
      const gOut = await call(tok, "GET", `/projects/${outRef}`);
      const kOut = await call(tok, "GET", `/projects/${outRef}/api-keys`);
      const hOut = await call(tok, "GET", `/projects/${outRef}/health`);
      results.push({
        id: "SP09a",
        title: "SP09a: direct reads, in scope vs out of scope",
        status: "info",
        measurements: {
          in_get_status: gIn.status,
          out_get_status: gOut.status,
          out_get_has_missing_permissions: denial(gOut).denied ? 1 : 0,
          out_api_keys_status: kOut.status,
          out_health_status: hOut.status,
        },
        evidence: `out GET: ${scrub(gOut.text)}\nout api-keys: ${scrub(kOut.text)}`,
      });

      const org = await call(tok, "GET", `/organizations/${slug}/projects`);
      const acct = await call(tok, "GET", "/projects");
      const o = refsOf(org.json);
      const a = refsOf(acct.json);
      results.push({
        id: "SP09b",
        title: "SP09b: listings seen by the project-scoped token",
        status: "info",
        measurements: {
          org_listing_status: org.status,
          org_listing_count: o.length,
          org_listing_has_in: o.includes(inRef) ? 1 : 0,
          org_listing_has_out: o.includes(outRef) ? 1 : 0,
          account_listing_status: acct.status,
          account_listing_count: a.length,
          account_listing_has_in: a.includes(inRef) ? 1 : 0,
          account_listing_has_out: a.includes(outRef) ? 1 : 0,
        },
      });

      const later = await createProject(ctx, slug, "sp09-later");
      if (later.ref) cleanup.push(later.ref);
      let listed: number | "never" | "n/a" = "n/a";
      let direct: number | "n/a" = "n/a";
      if (later.ref) {
        const t0 = Date.now();
        listed = "never";
        while (Date.now() - t0 < 60_000) {
          if (refsOf((await call(tok, "GET", `/organizations/${slug}/projects`)).json).includes(later.ref)) {
            listed = Math.round((Date.now() - t0) / 100) / 10;
            break;
          }
          await sleep(8_000);
        }
        direct = (await call(tok, "GET", `/projects/${later.ref}`)).status;
      }
      results.push({
        id: "SP09c",
        title: "SP09c: a project created after the project-scoped token",
        status: later.ref ? "info" : "fail",
        detail: later.ref ? undefined : `lab-token create HTTP ${later.status}`,
        measurements: { create_status: later.status, seconds_until_scoped_listing_has_it: listed, scoped_get_status: direct },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of IDS) if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      for (const ref of cleanup) await deleteProject(ctx, ref).catch(() => 0);
    }
    for (const id of IDS) if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
    return results;
  },
};
export default mod;
