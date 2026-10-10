/**
 * SP02 / SP03 - per-token x per-endpoint permission matrix, and the shape of
 * the 403 body.
 *
 * Probes are generated from the OpenAPI document's `x-fga-permissions` (see
 * lib/spec.ts): every parameter-free GET on `{ref}` / `{slug}`, two
 * `select 1` SQL calls, and the api-keys `reveal=true` flag. Each token is
 * run through the same list against one fixture project (supplied as
 * PVLAB_PEER_FIXTURE, or provisioned in the Pro org and deleted in `finally`).
 *
 *   SP02-lab  the lab token (`ctx.pat`) as baseline. A probe that is
 *                 refused here is a bad probe, not a scope result.
 *   SP02-<role>   one row per supplied scoped token: outcome counts, and the
 *                 agreement between the refusal the document predicts (from
 *                 the declared permissions and the role's assumed grants) and
 *                 the refusal observed.
 *   SP03-<role>   the 403 body: is `missing_permissions` an array, what other
 *                 keys travel with it, are the named permissions the ones the
 *                 document declares for that operation.
 *
 * Tokens that are not supplied skip with the exact dashboard hand-off. Only
 * statuses, outcome classes and permission names are recorded; response
 * bodies of 2xx probes are discarded (the reveal probe returns key secrets).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, denial, outcome, scrub } from "../lib/http.js";
import { isSkip, withFixture } from "../lib/fixture.js";
import { allowed, buildProbes, declaredNames, fetchSpec, type Probe } from "../lib/spec.js";
import { ROLES, grantsFor, skipReason, tokenFor, type Role } from "../lib/tokens.js";

interface Row {
  id: string;
  status: number;
  outcome: string;
  missing: string[];
  predictedDenied: boolean;
  declared: string[];
  keys: string[];
  sample?: string;
}

async function sweep(
  token: string,
  probes: Probe[],
  ref: string,
  slug: string,
  grants: ReadonlySet<string> | "all",
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const p of probes) {
    if (p.template.includes("{slug}") && !slug) continue;
    const path = p.template.replace("{ref}", ref).replace("{slug}", slug) + (p.query ? `?${p.query}` : "");
    const r = await call(token, p.method, path, p.body);
    const d = denial(r);
    rows.push({
      id: p.id,
      status: r.status,
      outcome: outcome(r),
      missing: d.missing,
      predictedDenied: grants === "all" ? false : !allowed(p.needs, grants),
      declared: [...declaredNames(p.needs)].sort(),
      keys: d.keys,
      sample: r.status === 403 ? scrub(r.text, 300) : undefined,
    });
  }
  return rows;
}

const count = (rows: Row[], f: (r: Row) => boolean) => rows.filter(f).length;

function summarise(role: string, rows: Row[], baseline: boolean): TestResult {
  const denied = count(rows, (r) => r.outcome === "denied");
  const ok = count(rows, (r) => r.outcome === "ok");
  const agree = count(rows, (r) => r.predictedDenied === (r.outcome === "denied"));
  const mismatch = rows.filter((r) => r.predictedDenied !== (r.outcome === "denied"));
  return {
    id: `SP02-${role}`,
    title: `SP02-${role}: ${baseline ? "lab token baseline" : "scoped token"} across ${rows.length} probes`,
    status: baseline ? (denied === 0 && ok > 0 ? "pass" : "info") : "info",
    detail: baseline
      ? denied === 0
        ? "no probe refused with missing_permissions; the probe list is usable and this token is not narrower than the probes"
        : `${denied} probes refused for the lab token (a bad probe or a narrower token than assumed; read SP03-lab): ${rows.filter((r) => r.outcome === "denied").map((r) => r.id).join(",")}`
      : `predicted-vs-observed disagree on ${mismatch.length} of ${rows.length}`,
    measurements: {
      probes: rows.length,
      ok,
      denied_missing_permissions: denied,
      forbidden_other: count(rows, (r) => r.outcome === "403-other"),
      unauthorized_401: count(rows, (r) => r.outcome === "401"),
      other_status: count(rows, (r) => r.outcome.startsWith("other-")),
      predicted_denied: count(rows, (r) => r.predictedDenied),
      agree,
      disagree: mismatch.length,
    },
    evidence: JSON.stringify({
      statuses: Object.fromEntries(rows.map((r) => [r.id, `${r.status}${r.outcome === "denied" ? "D" : ""}`])),
      mismatches: mismatch.map((r) => `${r.id}: predicted ${r.predictedDenied ? "denied" : "allowed"}, observed ${r.outcome}`),
    }),
  };
}

function shapeRow(role: string, rows: Row[]): TestResult {
  const den = rows.filter((r) => r.outcome === "denied");
  const other403 = rows.filter((r) => r.outcome === "403-other");
  const keysets = [...new Set(den.map((r) => r.keys.join("+")))];
  const subset = den.filter((r) => r.missing.every((m) => r.declared.includes(m)));
  const names = [...new Set(den.flatMap((r) => r.missing))].sort();
  return {
    id: `SP03-${role}`,
    title: `SP03-${role}: 403 body shape`,
    status: den.length || other403.length ? "info" : "skip",
    detail: den.length || other403.length ? undefined : "no 403 from this token; nothing to read",
    measurements: {
      denied_with_missing_array: den.length,
      forbidden_without_array: other403.length,
      body_key_sets: keysets.join(" | ") || "n/a",
      missing_subset_of_declared: `${subset.length} of ${den.length}`,
      distinct_missing_names: names.length,
    },
    evidence: `names: ${names.join(",")}\nsample denied: ${den[0]?.sample ?? "n/a"}\nsample other 403: ${other403[0]?.sample ?? "n/a"}`,
  };
}

const mod: TestModule = {
  id: "SP02",
  title: "Scoped token permission matrix and 403 body",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const spec = await fetchSpec();
    if ("error" in spec) return [{ id: "SP02-lab", title: "SP02", status: "fail", detail: `spec fetch ${spec.error}` }];
    const probes = buildProbes(spec.ops);
    const names = new Set(spec.ops.flatMap((o) => o.needs?.flat() ?? []));
    const slug = ctx.orgs.pro ?? "";

    const supplied: Role[] = ROLES.filter((r) => ["legacy", "org", "ro", "dbrw", "narrow"].includes(r.role) && tokenFor(r));
    const results: TestResult[] = [];
    for (const r of ROLES.filter((x) => ["legacy", "org", "ro", "dbrw", "narrow"].includes(x.role))) {
      if (!tokenFor(r)) {
        for (const id of [`SP02-${r.role}`, `SP03-${r.role}`]) {
          results.push({ id, title: id, status: "skip", detail: skipReason(r) });
        }
      }
    }

    const res = await withFixture(ctx, async (ref, provisioned) => {
      const rows = await sweep(ctx.pat ?? "", probes, ref, slug, "all");
      const out: TestResult[] = [summarise("lab", rows, true)];
      out[0]!.detail = `${out[0]!.detail}; fixture ${provisioned ? "self-provisioned" : "supplied"}`;
      for (const r of supplied) {
        const rr = await sweep(tokenFor(r), probes, ref, slug, grantsFor(r, names));
        out.push(summarise(r.role, rr, false), shapeRow(r.role, rr));
      }
      return out;
    });
    if (isSkip(res)) {
      return [
        { id: "SP02-lab", title: "SP02-lab", status: "skip", detail: res.skip },
        ...results,
      ];
    }
    return [...res, ...results];
  },
};
export default mod;
