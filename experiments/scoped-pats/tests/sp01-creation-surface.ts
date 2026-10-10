/**
 * SP01 - can a scoped PAT be created through any API, and what does the
 * public OpenAPI document say about permissions? Read-only, no project.
 *
 *   SP01a  control + scan: the OpenAPI document fetched with a path count and
 *          the two routes every account has; then every path / operationId
 *          matched against access-token creation shapes.
 *   SP01b  the dashboard's own route (`/platform/profile/access-tokens`, from
 *          the open-source Studio client) probed with a lab token, GET only
 *          (nothing is created), against a `/v1/organizations` control in the same
 *          run so a dead token cannot read as a refusal.
 *   SP01c  inventory of `x-fga-permissions` / `x-oauth-scope` in the document:
 *          how many operations declare them, how many distinct names, which
 *          operations declare none. Doc-derived, not a measurement of
 *          enforcement.
 *   SP01d  token format classes: the lab token in use, and each supplied
 *          scoped token (class only, never the value).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, scrub } from "../lib/http.js";
import { buildProbes, fetchSpec } from "../lib/spec.js";
import { ROLES, shape, tokenFor } from "../lib/tokens.js";

const CREATION_SHAPE = /access[-_]?token|personal|\bpat\b|api[-_]?token|profile\/token/i;

const mod: TestModule = {
  id: "SP01",
  title: "Scoped PAT creation surface and declared permission map",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const pat = ctx.pat ?? "";
    const out: TestResult[] = [];

    const spec = await fetchSpec();
    if ("error" in spec) {
      return [{ id: "SP01a", title: "SP01a: OpenAPI scan", status: "fail", detail: `spec fetch ${spec.error}` }];
    }
    const paths = [...new Set(spec.ops.map((o) => o.path))];
    const hasControl = paths.includes("/v1/projects") && paths.includes("/v1/organizations");
    const matches = spec.ops.filter((o) => CREATION_SHAPE.test(`${o.path} ${o.operationId}`));
    const claimOrOauth = matches.filter((o) => /claim|oauth/.test(o.path));
    const creation = matches.filter((o) => !/claim|oauth/.test(o.path));
    out.push({
      id: "SP01a",
      title: "SP01a: no access-token creation operation in the public OpenAPI document",
      status: !hasControl ? "skip" : creation.length === 0 ? "pass" : "fail",
      detail: !hasControl
        ? "control routes /v1/projects and /v1/organizations absent from the document; scan is uninterpretable"
        : creation.length === 0
          ? "no creation operation; claim-token and oauth routes matched the pattern and are a different mechanism"
          : `matched: ${creation.map((o) => `${o.method} ${o.path}`).join("; ")}`,
      measurements: {
        spec_paths: spec.pathCount,
        spec_operations: spec.ops.length,
        spec_sha256_16: spec.sha256,
        creation_matches: creation.length,
        claim_or_oauth_matches: claimOrOauth.length,
      },
    });

    // ---- SP01b ----
    const ctl = await call(pat, "GET", "/organizations");
    const prof = await call(pat, "GET", "/profile");
    const dash = await call(pat, "GET", "/platform/profile/access-tokens", undefined, { origin: true });
    const v1a = await call(pat, "GET", "/profile/access-tokens");
    const v1b = await call(pat, "GET", "/access-tokens");
    out.push({
      id: "SP01b",
      title: "SP01b: the dashboard's token route with a lab token (GET only, nothing created)",
      status: ctl.status !== 200 ? "skip" : "info",
      detail:
        ctl.status !== 200
          ? `control GET /v1/organizations HTTP ${ctl.status}; token unusable, probe uninterpretable`
          : `dashboard route HTTP ${dash.status}: ${scrub(dash.text)}`,
      measurements: {
        control_organizations_status: ctl.status,
        v1_profile_status: prof.status,
        platform_access_tokens_status: dash.status,
        v1_profile_access_tokens_status: v1a.status,
        v1_access_tokens_status: v1b.status,
      },
      evidence: `platform body: ${scrub(dash.text)}\nv1 profile body: ${scrub(prof.text)}`,
    });

    // ---- SP01c ----
    const withFga = spec.ops.filter((o) => o.needs);
    const without = spec.ops.filter((o) => !o.needs);
    const names = new Set(withFga.flatMap((o) => o.needs?.flat() ?? []));
    const oauth = new Set(spec.ops.map((o) => o.oauthScope).filter(Boolean));
    const probes = buildProbes(spec.ops);
    out.push({
      id: "SP01c",
      title: "SP01c: x-fga-permissions declared per operation (doc-derived)",
      status: "info",
      detail: `no declared permissions: ${without.map((o) => `${o.method} ${o.path}`).join("; ")}`,
      measurements: {
        operations: spec.ops.length,
        with_fga: withFga.length,
        without_fga: without.length,
        distinct_permission_names: names.size,
        distinct_oauth_scopes: oauth.size,
        generated_probes: probes.length,
      },
      evidence: [...names].sort().join(","),
    });

    // ---- SP01d ----
    const shapes: Record<string, string> = { lab_token: shape(pat) };
    for (const r of ROLES) {
      const t = tokenFor(r);
      shapes[r.role] = t ? shape(t) : "not supplied";
    }
    out.push({
      id: "SP01d",
      title: "SP01d: token format classes (docs: scoped tokens start with sbp_fc)",
      status: "info",
      measurements: shapes,
    });
    return out;
  },
};
export default mod;
