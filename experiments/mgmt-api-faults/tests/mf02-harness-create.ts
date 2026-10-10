/**
 * MF02 - a non-idempotent POST (project create) whose answer is lost.
 *
 * The create call is the one Management API write every experiment makes, and
 * the one whose duplicate costs money. Two ways the caller can lose the answer
 * after upstream has done the work, both through the fault proxy:
 *
 *   MF02a  the answer is held longer than the client's timeout (proxy
 *          delay-after 8 s, client timeout 4 s): the client throws, makes no
 *          second attempt, and the project exists afterwards (an orphan).
 *   MF02b  the answer is replaced by a 500 (proxy error-after): the client
 *          sees 500, the project exists. A caller that then retries the same
 *          create (same name, same org) is MF02c.
 *   MF02c  the retry of MF02b: does the platform refuse the repeat name, or
 *          create a second project with it. Reads the org listing directly
 *          (not through the proxy).
 *
 * Creates up to three projects named with the experiment prefix; every one is
 * deleted in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { attempts, dbPassword, listPrefixed, missingTool, NAME_PREFIX, scrub, shape, sweep, waitGone, withProxy } from "../lib/proxy.js";

const POST = /^\/v1\/projects$/;
const body = (org: string, name: string) => ({
  organization_slug: org,
  name,
  db_pass: dbPassword(),
  region: "ap-southeast-1",
});

async function named(ctx: Ctx, name: string, waitMs = 20_000) {
  const t0 = Date.now();
  let rows = (await listPrefixed(ctx)).filter((p) => p.name === name);
  while (rows.length === 0 && Date.now() - t0 < waitMs) {
    await Bun.sleep(4000);
    rows = (await listPrefixed(ctx)).filter((p) => p.name === name);
  }
  return rows;
}

const mod: TestModule = {
  id: "MF02",
  title: "Project create (POST) whose answer is lost: timeout and 500-after-success",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = await missingTool(["docker"]);
    if (missing) return [{ id: "MF02", title: this.title, status: "skip", detail: missing }];
    const results: TestResult[] = [];
    try {
      await withProxy(async (px) => {
        const pctx = { ...ctx, mgmtBase: `${px.url}/v1` } as Ctx;

        // ---- MF02a: held answer vs client timeout ----
        await px.reset();
        const nameA = `${NAME_PREFIX}h-a-${Date.now()}`;
        await px.setRules([{ id: "hold8", method: "POST", path: "^/v1/projects$", mode: "delay-after", delayMs: 8000 }]);
        let outcome = "";
        const ta = Date.now();
        try {
          const r = await mgmt(pctx, "POST", "/projects", body(org, nameA), 4000);
          outcome = `returned ${r.status}`;
        } catch (e) {
          outcome = `threw ${(e as Error).name}`;
        }
        const msA = Date.now() - ta;
        await Bun.sleep(10_000);
        const la = await px.log();
        const orphansA = await named(ctx, nameA);
        results.push({
          id: "MF02a",
          title: "MF02a: create answer held past the client timeout",
          status: orphansA.length > 0 ? "info" : "fail",
          detail: `client ${outcome} after ${msA} ms; ${attempts(la, "POST", POST).length} POST attempt(s); upstream status ${la[0]?.upstreamStatus ?? "-"}; projects with that name afterwards: ${orphansA.length}`,
          measurements: { client_ms: msA, post_attempts: attempts(la, "POST", POST).length, upstream_status: la[0]?.upstreamStatus ?? -1, orphans: orphansA.length },
          evidence: shape(la),
        });

        // ---- MF02b: 500 after success ----
        await px.reset();
        const nameB = `${NAME_PREFIX}h-b-${Date.now()}`;
        await px.setRules([{ id: "after500", method: "POST", path: "^/v1/projects$", mode: "error-after", status: 500, times: 1 }]);
        const rb = await mgmt(pctx, "POST", "/projects", body(org, nameB));
        const lb = await px.log();
        const orphansB = await named(ctx, nameB);
        results.push({
          id: "MF02b",
          title: "MF02b: create answered 500 after upstream created the project",
          status: orphansB.length > 0 ? "info" : "fail",
          detail: `client got ${rb.status}; upstream status ${lb[0]?.upstreamStatus ?? "-"}; ${attempts(lb, "POST", POST).length} POST attempt(s); projects with that name: ${orphansB.length}`,
          measurements: { client_status: rb.status, upstream_status: lb[0]?.upstreamStatus ?? -1, post_attempts: attempts(lb, "POST", POST).length, orphans: orphansB.length },
          evidence: scrub(rb.text.slice(0, 200)),
        });

        // ---- MF02c: the caller's retry, same name ----
        await px.reset();
        const rc = await mgmt(pctx, "POST", "/projects", body(org, nameB));
        await Bun.sleep(6000);
        const after = (await listPrefixed(ctx)).filter((p) => p.name === nameB);
        results.push({
          id: "MF02c",
          title: "MF02c: second create with the same name and org",
          status: "info",
          detail: `second POST answered ${rc.status}; projects with that name now: ${after.length}`,
          measurements: { second_status: rc.status, projects_with_name: after.length },
          evidence: scrub(rc.text.slice(0, 300)),
        });
      });
    } catch (e) {
      results.push({ id: "MF02", title: "MF02", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await sweep(ctx).catch(() => 0);
      await waitGone(ctx, undefined, 120_000).catch(() => false);
    }
    return results;
  },
};
export default mod;
