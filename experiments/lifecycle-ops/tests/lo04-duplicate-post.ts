/**
 * LO04 - does re-sending an identical POST /v1/projects create a duplicate?
 *
 * DESTRUCTIVE and self-provisioning: at most TWO `lo-` Micro
 * projects in the Pro org (PVLAB_ORG_PRO), both deleted in `finally`.
 *
 * The case a retry wrapper meets: a create is sent, the caller never gets the
 * answer (5xx, timeout, dropped connection), and retries the same request.
 *
 *   LO04a  first POST, with the CALLER'S WAIT CAPPED at ABORT_MS so the
 *          response may be abandoned (recorded either way: answered 201 inside
 *          the cap, or abandoned). Then the org listing is read for projects
 *          carrying this name: does an abandoned request leave a project?
 *   LO04b  the identical POST sent again (same name, same body bytes, same
 *          region) immediately after, while the first project is still being
 *          provisioned. Recorded: HTTP status and body, whether the ref
 *          differs from the first, and how many projects now carry the name.
 *          Name collision behaviour is read off this.
 *   LO04c  the org listing for this name after both have settled for
 *          SETTLE_S, with statuses, so a second project that appears late is
 *          not missed.
 *
 * Not measured: an Idempotency-Key header (no documented support was found in
 * the published OpenAPI document; sending one on both requests would have
 * confounded LO04b), a genuine server 5xx (cannot be induced from a client),
 * and two requests sent concurrently.
 *
 * Status is info: both outcomes (duplicate created, or collision rejected) are
 * measurements. Teardown failures fail the module.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { gate } from "../lib/gate";
import { RUN, createBody, deleteOurs, handoff, listOurs, nameFor, pollStatus, sleep, waitGone } from "../lib/project";

const REGION = "ap-southeast-1";
const ABORT_MS = 1000;
const SETTLE_S = 60;

const mod: TestModule = {
  id: "LO04",
  title: "Identical re-sent POST /v1/projects: duplicate or collision",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "LO04", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    const tag = nameFor("lo04");
    let firstRefSeen = "";
    let firstPostAtMs = Date.now();
    let dbPass = "";

    try {
      const g = await gate(REGION, "create");
      if (!g.proceed) {
        return [{ id: "LO04a", title: "LO04a: gate refused", status: "info", detail: g.blockers.join(" ; ") }];
      }
      const body = createBody(org, tag, REGION);
      dbPass = body.db_pass;

      // ---- a: first POST, response possibly abandoned ----
      const t1 = Date.now();
      firstPostAtMs = t1;
      const first = await mgmt(ctx, "POST", "/projects", body, ABORT_MS).catch(
        (e) => ({ status: 0, text: e instanceof Error ? `${e.name}: ${e.message}` : String(e), throttled: false }) as Awaited<ReturnType<typeof mgmt>>,
      );
      const firstMs = Date.now() - t1;
      const firstRef = (first.json as { ref?: string } | undefined)?.ref ?? "";
      firstRefSeen = firstRef;
      // Give a request the client abandoned time to show up in the listing.
      let seenAfterA = (await listOurs(ctx, org, tag)).length;
      const tw = Date.now();
      while (first.status === 0 && seenAfterA === 0 && Date.now() - tw < 60_000) {
        await sleep(10_000);
        seenAfterA = (await listOurs(ctx, org, tag)).length;
      }
      results.push({
        id: "LO04a",
        title: "LO04a: first POST with the caller's wait capped",
        status: "info",
        detail: first.status === 0 ? `abandoned after ${firstMs} ms (${first.text.slice(0, 80)}); projects with the name afterwards: ${seenAfterA}` : `answered HTTP ${first.status} in ${firstMs} ms`,
        measurements: {
          abort_cap_ms: ABORT_MS,
          first_http: first.status,
          first_ms: firstMs,
          first_response_had_ref: firstRef ? 1 : 0,
          projects_with_name_after_first: seenAfterA,
        },
      });

      // ---- b: identical re-send ----
      const t2 = Date.now();
      const second = await mgmt(ctx, "POST", "/projects", body).catch(
        (e) => ({ status: 0, text: String(e), throttled: false }) as Awaited<ReturnType<typeof mgmt>>,
      );
      const secondMs = Date.now() - t2;
      const secondRef = (second.json as { ref?: string } | undefined)?.ref ?? "";
      const afterB = await listOurs(ctx, org, tag);
      results.push({
        id: "LO04b",
        title: "LO04b: identical POST re-sent",
        status: "info",
        detail: `HTTP ${second.status} in ${secondMs} ms; ${afterB.length} project(s) now carry the name`,
        measurements: {
          second_http: second.status,
          second_ms: secondMs,
          second_ref_differs_from_first: firstRef && secondRef ? (firstRef !== secondRef ? 1 : 0) : "n/a (first ref not received)",
          projects_with_name_after_second: afterB.length,
        },
        evidence: `second body: ${second.text.slice(0, 300).replace(/\s+/g, " ")}`,
      });

      // ---- c: settle, then list again ----
      await sleep(SETTLE_S * 1000);
      const settled = await listOurs(ctx, org, tag);
      results.push({
        id: "LO04c",
        title: "LO04c: projects carrying the name after settling",
        status: "info",
        measurements: {
          settle_s: SETTLE_S,
          projects_with_name: settled.length,
          distinct_refs: new Set(settled.map((s) => s.ref)).size,
          statuses: settled.map((s) => s.status).join(","),
        },
      });
    } catch (e) {
      results.push({ id: "LO04x", title: "LO04: threw", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      const mine = await listOurs(ctx, org, RUN).catch(() => []);
      let bad = 0;
      let maxGone = 0;
      // LO_HANDOFF=1: leave one project (the first POST's, if known) running for LO05.
      const keepRef =
        process.env.LO_HANDOFF === "1" && mine.length > 0
          ? (mine.find((m) => m.ref === firstRefSeen) ?? mine[0])?.ref
          : undefined;
      for (const p of mine) {
        // A project still provisioning may refuse DELETE; let it settle first.
        await pollStatus(ctx, p.ref, "ACTIVE_HEALTHY", 600_000).catch(() => null);
        if (p.ref === keepRef) {
          Object.assign(handoff, { ref: p.ref, dbPass, org, createdAtMs: firstPostAtMs });
          continue;
        }
        let d = await deleteOurs(ctx, p.ref).catch(() => -2);
        if (!(d >= 200 && d < 300)) {
          await sleep(30_000);
          d = await deleteOurs(ctx, p.ref).catch(() => -2);
        }
        if (!(d >= 200 && d < 300)) bad += 1;
        else maxGone = Math.max(maxGone, await waitGone(ctx, org, p.ref).catch(() => -1));
      }
      const left = await listOurs(ctx, org, RUN).catch(() => []);
      results.push({
        id: "LO04d",
        title: "LO04d: teardown",
        status: bad === 0 && left.length === (keepRef ? 1 : 0) ? "pass" : "fail",
        measurements: {
          found: mine.length,
          delete_failures: bad,
          remaining: left.length,
          kept_for_lo05: keepRef ? 1 : 0,
          slowest_gone_s: maxGone,
        },
      });
    }
    return results;
  },
};
export default mod;
