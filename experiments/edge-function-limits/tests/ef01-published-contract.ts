/**
 * EF01 - what the PUBLISHED contract says, before any project is touched.
 *
 * The secrets limits are declared in the Management API's own request schema
 * (maxItems, maxLength, a name pattern), so all four can be compared to the
 * docs from the OpenAPI document alone. The function size ceiling is NOT in
 * the contract anywhere - which is itself the finding: it is a bundling-path
 * property enforced at deploy time, and EF04 measures it.
 *
 *   EF01a  secrets: declared contract vs docs (pass when all four agree)
 *   EF01b  deploy surface: legacy create deprecated? which responses does
 *          the multipart deploy declare? (info - if 413 is NOT declared, a
 *          413 comes from a layer in front of the documented handler)
 *   EF01c  static_patterns is in the API contract while the docs say static
 *          files cannot be deployed via the API (info; EF06d measures it)
 *
 * Read-only, no credential: the document is unauthenticated, so mgmt() is
 * not used (it prefixes /v1 and attaches a bearer).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { DOCS_READ_AT, SECRETS } from "../lib/docs";
import { deployContract, patternRejectsPrefix, secretsContract } from "../lib/spec";

const SPEC_URL = "https://api.supabase.com/api/v1-json";

const mod: TestModule = {
  id: "EF01",
  title: "Edge Function limits in the published API contract vs the docs",
  where: "local",
  async run(_ctx: Ctx): Promise<TestResult[]> {
    let spec: Record<string, unknown>;
    try {
      const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        return [{ id: "EF01", title: this.title, status: "fail", detail: `spec fetch: HTTP ${res.status}` }];
      }
      spec = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      return [
        {
          id: "EF01",
          title: this.title,
          status: "fail",
          detail: `spec fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ];
    }
    // Control: a half-arrived document would make every absence below meaningless.
    const pathCount = Object.keys((spec.paths ?? {}) as object).length;
    if (pathCount < 50) {
      return [
        {
          id: "EF01",
          title: this.title,
          status: "fail",
          detail: `only ${pathCount} paths parsed - document did not arrive intact`,
          measurements: { paths: pathCount },
        },
      ];
    }

    const s = secretsContract(spec);
    const prefixOk = patternRejectsPrefix(s.namePattern, SECRETS.reservedPrefix);
    const agree = {
      count: s.maxItems === SECRETS.maxPerProject,
      name: s.nameMaxLength === SECRETS.maxNameChars,
      value: s.valueMaxLength === SECRETS.maxValueChars,
      prefix: prefixOk,
    };
    const disagreements = Object.entries(agree)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    const out: TestResult[] = [];
    out.push({
      id: "EF01a",
      title: `secrets: declared contract vs docs (read ${DOCS_READ_AT})`,
      status: disagreements.length ? "fail" : "pass",
      detail: disagreements.length
        ? `contract disagrees with the docs on: ${disagreements.join(", ")}`
        : "all four secrets limits are declared in the request schema and match the docs",
      measurements: {
        contract_max_items: s.maxItems ?? "absent",
        docs_max_per_project: SECRETS.maxPerProject,
        contract_name_max_length: s.nameMaxLength ?? "absent",
        docs_name_max_chars: SECRETS.maxNameChars,
        contract_value_max_length: s.valueMaxLength ?? "absent",
        docs_value_max_chars: SECRETS.maxValueChars,
        contract_name_pattern: s.namePattern ?? "absent",
        pattern_rejects_reserved_prefix: prefixOk ? 1 : 0,
      },
    });

    const d = deployContract(spec);
    out.push({
      id: "EF01b",
      title: "function deploy surface as published",
      status: "info",
      detail:
        `legacy JSON create ${
          d.legacyCreatePublished ? (d.legacyCreateDeprecated ? "published, deprecated" : "published, NOT deprecated") : "absent"
        }; ` +
        `multipart deploy declares [${d.deployDeclaredResponses.join(",")}]` +
        (d.deployDeclaredResponses.includes("413") ? "" : " - 413 is not a declared response") +
        (d.sizeLimitMentioned ? "; a size limit is mentioned in the contract" : "; no size ceiling is expressed in the contract"),
      measurements: {
        legacy_create_published: d.legacyCreatePublished ? 1 : 0,
        legacy_create_deprecated: d.legacyCreateDeprecated ? 1 : 0,
        deploy_declared_responses: d.deployDeclaredResponses.join("|"),
        deploy_declares_413: d.deployDeclaredResponses.includes("413") ? 1 : 0,
        deploy_declares_429: d.deployDeclaredResponses.includes("429") ? 1 : 0,
        size_limit_in_contract: d.sizeLimitMentioned ? 1 : 0,
      },
    });

    out.push({
      id: "EF01c",
      title: "static_patterns in the API deploy contract",
      status: "info",
      detail: d.staticPatternsDeclared
        ? "static_patterns IS a declared metadata field on the API deploy, while the docs say static files cannot be deployed via the API - EF06d measures which is true"
        : "static_patterns is not declared on the API deploy; the docs' restriction and the contract agree",
      measurements: {
        static_patterns_declared: d.staticPatternsDeclared ? 1 : 0,
        deploy_metadata_fields: d.deployMetadataFields.join("|"),
      },
    });
    return out;
  },
};
export default mod;
