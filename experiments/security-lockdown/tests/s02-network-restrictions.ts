/**
 * S02 - network restrictions APPLIED (iap-lockdown L09 only enumerated them).
 *
 * Apply a restrictive CIDR, confirm the API recorded it, and measure the
 * split: the HTTP tier (REST) keeps answering - restrictions gate the
 * DB/pooler socket, not the Data API. Restore 0.0.0.0/0 in finally.
 *
 * Uses a TEST-NET CIDR (192.0.2.0/24) rather than restrict-all so the
 * Management SQL path used by sibling modules is never cut off.
 *
 * DESTRUCTIVE: mutates network restrictions; restores in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, waitFor } from "../lib/sec.js";

const RESTRICT = { dbAllowedCidrs: ["192.0.2.0/24"], dbAllowedCidrsV6: ["2001:db8::/32"] };
const OPEN = { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] };

const mod: TestModule = {
  id: "S02",
  title: "network restrictions applied: DB-scoped, HTTP tier untouched",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const results: TestResult[] = [];
    const restBefore = await http(`https://${ctx.apiHost}/rest/v1/`, { key: keys.anonJwt });

    try {
      const apply = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, RESTRICT);
      results.push({
        id: "S02a",
        title: "apply a restrictive DB CIDR",
        status: apply.status < 300 ? "pass" : "fail",
        detail: apply.status < 300 ? "network restriction applied (TEST-NET CIDR)" : `apply HTTP ${apply.status} ${apply.text.slice(0, 150)}`,
        measurements: { apply_status: apply.status },
        evidence: apply.text.slice(0, 200),
      });
      if (apply.status >= 300) return results;

      // Confirm the API recorded it.
      const got = await mgmt(ctx, "GET", `/projects/${ctx.ref}/network-restrictions`);
      const applied = JSON.stringify(got.json).includes("192.0.2.0/24");
      results.push({
        id: "S02b",
        title: "restriction is recorded",
        status: applied ? "pass" : "fail",
        detail: `GET network-restrictions contains the CIDR=${applied}`,
        evidence: JSON.stringify(got.json).slice(0, 300),
      });

      // The point: the HTTP tier is unaffected.
      const restAfter = await waitFor(async () => (await http(`https://${ctx.apiHost}/rest/v1/${""}`, { key: keys.anonJwt })).status === restBefore.status, 30_000);
      const rest = await http(`https://${ctx.apiHost}/rest/v1/`, { key: keys.anonJwt });
      results.push({
        id: "S02c",
        title: "REST HTTP tier keeps answering under DB network restrictions",
        status: rest.status === restBefore.status ? "pass" : "fail",
        detail: `REST /rest/v1/ = ${rest.status} (was ${restBefore.status} before) after ${restAfter.elapsedS}s - restrictions gate the DB/pooler socket, not the Data API. So an IP allowlist does NOT cover REST/Auth/Storage.`,
        measurements: { rest_before: restBefore.status, rest_after: rest.status },
      });
    } catch (e) {
      results.push({ id: "S02err", title: "S02 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      const back = await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, OPEN);
      results.push({
        id: "S02z",
        title: "restore open network restrictions",
        status: back.status < 300 ? "pass" : "fail",
        detail: back.status < 300 ? "restored 0.0.0.0/0" : `restore HTTP ${back.status} - DB LEFT RESTRICTED (project destroyed at end of run)`,
      });
    }
    return results;
  },
};
export default mod;
