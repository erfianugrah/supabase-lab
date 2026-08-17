/**
 * I02 - smart region selection on a normal paid org.
 *
 * `POST /v1/projects` accepts `region_selection: { type: "smartGroup",
 * code: "americas" | "emea" | "apac" }` instead of a concrete `region`,
 * letting the platform pick the highest-capacity city. The public API spec
 * carries the field; nothing says what a normal Pro org gets back or
 * whether it is accepted at all. This module creates a project with the
 * apac smart group and records what lands.
 *
 *   I02a  create with region_selection apac -> poll healthy -> read back the
 *         concrete region -> delete. Whatever happens is the finding.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni"; // same Pro org as w21/i01/m01

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectReadResponse {
  status?: string;
  region?: string;
}

const mod: TestModule = {
  id: "I02",
  title: "Smart region selection on a normal paid org",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project
  async run(ctx: Ctx): Promise<TestResult> {
    let ref = "";
    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `i02-smart-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code: "apac" },
      });

      if (create.status !== 201) {
        return {
          id: "I02a",
          title: "I02a: create with smartGroup apac",
          status: "info",
          detail: `smartGroup create rejected: HTTP ${create.status}`,
          measurements: { smart_create_status: create.status },
          evidence: create.text.slice(0, 300),
        };
      }

      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (!ref) {
        return {
          id: "I02a",
          title: "I02a: create with smartGroup apac",
          status: "info",
          detail: `HTTP 201 with no ref: ${create.text.slice(0, 300)}`,
          measurements: { smart_create_status: create.status },
        };
      }

      let read: ProjectReadResponse = {};
      for (let i = 0; i < 90 && read.status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        read = (p.json as ProjectReadResponse | undefined) ?? {};
      }

      return {
        id: "I02a",
        title: "I02a: create with smartGroup apac",
        status: read.status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail:
          read.status === "ACTIVE_HEALTHY"
            ? `smartGroup picked: ${read.region ?? "unreported"}`
            : `not healthy after 15 min (status=${read.status ?? "unknown"}, region=${read.region ?? "unreported"})`,
        measurements: {
          smart_create_status: create.status,
          region_assigned: read.region ?? "unreported",
          provision_s: Math.round((Date.now() - t0) / 1000),
        },
      };
    } catch (e) {
      return {
        id: "I02a",
        title: "I02a: create with smartGroup apac",
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
  },
};
export default mod;
