/**
 * AV03 - where audit.sql and the advisors disagree on an exposure, ask the
 * Data API with the legacy anon key which one was right. Runs after AV02 on
 * the same seeded project.
 *
 *   AV03a  F02: GET /rest/v1/av_f02_rls_off_public_grant (RLS off, anon reaches
 *          it only through PUBLIC) - status and body
 *   AV03b  F08 control and F09 (after REVOKE ... FROM PUBLIC only):
 *          POST /rest/v1/rpc/<fn> - status and body
 *   AV03c  F10: POST /rest/v1/rpc/av_f10_definer_private with
 *          Content-Profile: av_private (schema not exposed) - status and body
 *   AV03d  F27: anon INSERT with Prefer return=representation and with
 *          return=minimal - status and body each
 *   AV03e  F03: GET /rest/v1/av_f03_rls_off_api with Accept-Profile: av_api
 *          - status and body
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { brief, currentProject, dataApi, pollApi, skipWithoutPro, type RestResult } from "../../data-api-defaults/lib/project.js";

const mod: TestModule = {
  id: "AV03",
  title: "Ground truth for the disagreements: anon through the Data API",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "AV03");
    if (skip) return skip;
    const p = currentProject();
    if (!p || !p.keys.anon) return [{ id: "AV03", title: "AV03", status: "skip", detail: "no seeded project in this process (run with AV02)" }];
    const red = (r: RestResult) => brief(p, r.body, 240);
    const anon = p.keys.anon;
    const rows: TestResult[] = [];
    const rec = (id: string, title: string, r: RestResult, extra: Record<string, number | string> = {}) =>
      rows.push({ id, title, status: "info", detail: `${r.status} ${red(r)}`, measurements: { status: r.status, body: red(r), ...extra } });

    // The schema cache reload after AV02's DDL is asynchronous; wait for a table AV02 seeded to appear.
    const warm = await pollApi(
      () => dataApi(p.host, "/rest/v1/av_f01_rls_off?select=id", anon),
      (r) => r.status === 200,
      60_000,
      3_000,
    );

    rec("AV03a", "AV03a: F02 anon GET, RLS off, granted to PUBLIC only", await dataApi(p.host, "/rest/v1/av_f02_rls_off_public_grant?select=*", anon), {
      warmup_s: warm.s,
    });
    rec("AV03b-F08", "AV03b: F08 anon RPC, definer with default privileges (control)", await dataApi(p.host, "/rest/v1/rpc/av_f08_definer_default", anon, { method: "POST", body: {} }));
    rec("AV03b-F09", "AV03b: F09 anon RPC after REVOKE EXECUTE ... FROM PUBLIC", await dataApi(p.host, "/rest/v1/rpc/av_f09_definer_revoked_public", anon, { method: "POST", body: {} }));
    rec(
      "AV03c",
      "AV03c: F10 anon RPC into the unexposed schema av_private",
      await dataApi(p.host, "/rest/v1/rpc/av_f10_definer_private", anon, { method: "POST", body: {}, headers: { "Content-Profile": "av_private" } }),
    );
    rec(
      "AV03d-rep",
      "AV03d: F27 anon INSERT, Prefer return=representation",
      await dataApi(p.host, "/rest/v1/av_f27_insert_only", anon, { method: "POST", body: { body: "rep" }, headers: { Prefer: "return=representation" } }),
    );
    rec(
      "AV03d-min",
      "AV03d: F27 anon INSERT, Prefer return=minimal",
      await dataApi(p.host, "/rest/v1/av_f27_insert_only", anon, { method: "POST", body: { body: "min" }, headers: { Prefer: "return=minimal" } }),
    );
    rec(
      "AV03e",
      "AV03e: F03 anon GET in the second exposed schema av_api",
      await dataApi(p.host, "/rest/v1/av_f03_rls_off_api?select=*", anon, { headers: { "Accept-Profile": "av_api" } }),
    );
    return rows;
  },
};
export default mod;
