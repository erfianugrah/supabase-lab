/**
 * LO03 - project creation through a region-fallback wrapper, n=3, with the
 * failure responses recorded.
 *
 * DESTRUCTIVE and self-provisioning: creates three `lo-` Micro
 * projects in the Pro org (PVLAB_ORG_PRO), one after another, deleting each
 * before the next create.
 *
 *   LO03a  requests that must fail (unknown region code, unknown org slug,
 *          missing name, unknown instance size): HTTP status and body of each,
 *          and whether the org listing shows a project afterwards (orphan
 *          check). These are the failure bodies a fallback wrapper has to
 *          classify. They are client-side invalid requests, NOT a capacity or
 *          provisioning failure: that failure mode cannot be induced from a
 *          client and is not measured here.
 *   LO03b  three creates through createWithFallback. Create 1 is given the
 *          list [unknown-region, ap-southeast-1], so the wrapper is seen
 *          falling through a real 4xx; creates 2 and 3 use [ap-southeast-1].
 *          Per create: gate decision, attempts, create call ms, status
 *          transitions and seconds to ACTIVE_HEALTHY (10 s poll, from just
 *          before the POST), then DELETE and seconds until the ref leaves the
 *          org listing.
 *   LO03c  leftovers: projects with this run's name tag still in the org
 *          listing after the loop (expected 0).
 *
 * Pass = every create reached ACTIVE_HEALTHY and nothing was left over.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { gate } from "../lib/gate";
import { p50 } from "../lib/probes";
import {
  RUN,
  createBody,
  createWithFallback,
  deleteOurs,
  fmtTransitions,
  listOurs,
  nameFor,
  pollStatus,
  waitGone,
} from "../lib/project";

const REGION = "ap-southeast-1";
const BAD_REGION = "zz-nowhere-1";

const mod: TestModule = {
  id: "LO03",
  title: "Create under failure: fallback wrapper, n=3 time to ACTIVE_HEALTHY",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "LO03", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    const made: string[] = [];

    try {
      // ---- a: requests that must fail ----
      const name = nameFor("lo03neg");
      const base = createBody(org, name, REGION);
      const cases: [string, unknown][] = [
        ["unknown_region", createBody(org, name, BAD_REGION)],
        ["unknown_org", { ...base, organization_slug: "no-such-org-lifecycle" }],
        ["missing_name", { ...base, name: undefined }],
        ["unknown_size", { ...base, desired_instance_size: "gigantic" }],
      ];
      const m: Record<string, number | string> = {};
      const ev: string[] = [];
      for (const [label, body] of cases) {
        const t = Date.now();
        const r = await mgmt(ctx, "POST", "/projects", body).catch(
          (e) => ({ status: 0, text: String(e), throttled: false }) as Awaited<ReturnType<typeof mgmt>>,
        );
        m[`${label}_http`] = r.status;
        m[`${label}_ms`] = Date.now() - t;
        ev.push(`${label}: HTTP ${r.status} ${r.text.slice(0, 200).replace(/\s+/g, " ")}`);
      }
      const leftovers = await listOurs(ctx, org, RUN);
      m.projects_listed_after_failed_creates = leftovers.length;
      for (const l of leftovers) made.push(l.ref);
      results.push({
        id: "LO03a",
        title: "LO03a: failed creates: status, body, orphan check",
        status: leftovers.length === 0 ? "pass" : "fail",
        measurements: m,
        evidence: ev.join("\n"),
      });

      // ---- b: three creates ----
      const tth: number[] = [];
      const callMs: number[] = [];
      for (let n = 1; n <= 3; n++) {
        const g = await gate(REGION, "create");
        const ev3: string[] = [`gate: proceed=${g.proceed} blockers=${g.blockers.length} warnings=${g.warnings.length}`];
        if (!g.proceed) {
          results.push({
            id: `LO03b${n}`,
            title: `LO03b${n}: gate refused`,
            status: "info",
            detail: g.blockers.join(" ; "),
          });
          continue;
        }
        const t0 = Date.now();
        const regions = n === 1 ? [BAD_REGION, REGION] : [REGION];
        const c = await createWithFallback(ctx, org, nameFor(`lo03-${n}`), regions);
        const meas: Record<string, number | string> = {
          create_n: n,
          attempts: c.attempts.length,
          landed_region: c.region ?? "none",
          region_list: regions.join(">"),
        };
        c.attempts.forEach((a, i) => {
          meas[`attempt${i + 1}_http`] = a.http;
          meas[`attempt${i + 1}_ms`] = a.ms;
          ev3.push(`attempt ${i + 1} ${a.region}: HTTP ${a.http} ${a.ms} ms ${a.body.slice(0, 160).replace(/\s+/g, " ")}`);
        });
        if (!c.ref) {
          results.push({ id: `LO03b${n}`, title: `LO03b${n}: create`, status: "fail", measurements: meas, evidence: ev3.join("\n") });
          continue;
        }
        made.push(c.ref);
        const landed = c.attempts.at(-1);
        callMs.push(landed?.ms ?? 0);
        const h = await pollStatus(ctx, c.ref, "ACTIVE_HEALTHY", 900_000, t0);
        meas.active_healthy_s = Math.round(h.ms / 1000);
        meas.reached_healthy = h.reached ? 1 : 0;
        if (h.reached) tth.push(h.ms / 1000);
        ev3.push(`transitions (10 s poll from before the POST): ${fmtTransitions(h.transitions)}`);
        const del = await deleteOurs(ctx, c.ref);
        meas.delete_http = del;
        meas.gone_from_org_listing_s = del >= 200 && del < 300 ? await waitGone(ctx, org, c.ref) : -1;
        results.push({
          id: `LO03b${n}`,
          title: `LO03b${n}: create ${n} of 3 through the fallback wrapper`,
          status: h.reached ? "pass" : "fail",
          measurements: meas,
          evidence: ev3.join("\n"),
        });
      }
      if (tth.length) {
        results.push({
          id: "LO03b",
          title: "LO03b: time to ACTIVE_HEALTHY across the creates",
          status: tth.length === 3 ? "pass" : "fail",
          measurements: {
            creates_healthy: `${tth.length} of 3`,
            active_healthy_p50_s: Math.round(p50(tth)),
            active_healthy_min_s: Math.round(Math.min(...tth)),
            active_healthy_max_s: Math.round(Math.max(...tth)),
            create_call_ms_p50: Math.round(p50(callMs)),
            poll_interval_s: 10,
          },
        });
      }
    } catch (e) {
      results.push({ id: "LO03x", title: "LO03: threw", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      for (const ref of made) await deleteOurs(ctx, ref).catch(() => -2);
      const left = await listOurs(ctx, org, RUN).catch(() => []);
      results.push({
        id: "LO03c",
        title: "LO03c: leftovers carrying this run's name tag",
        status: left.length === 0 ? "pass" : "fail",
        measurements: { remaining: left.length },
        detail: left.length ? left.map((l) => `${l.name}:${l.status}`).join(",") : undefined,
      });
    }
    return results;
  },
};
export default mod;
