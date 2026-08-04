/**
 * F02 - the project-scoped constants the docs quote as bare numbers.
 *
 * Compute prices, per-tier connection counts, the API-key shape, the signing
 * key shape, the per-service health endpoint, and the Postgres major a new
 * project lands on. Every one of those appears in at least one published doc
 * with no as-of date; several appear in a doc with no date at all.
 *
 * All GETs. The point is a dated snapshot that can be diffed against the last
 * one, so nothing here asserts a value - `info` records what the platform
 * says today. The two exceptions are shape assertions (four keys, health
 * reports per service), which are load-bearing for scripts in the guides and
 * DO have a right answer.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

/** `$0.01344` out of "\$0.01344 per hour" - prices are prose in this API. */
function hourlyRate(desc: unknown): string {
  const m = typeof desc === "string" ? desc.match(/([\d.]+)/) : null;
  return m?.[1] ?? "unparsed";
}

async function computeCatalogue(ctx: Ctx): Promise<TestResult> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/billing/addons`);
  if (r.status !== 200 || !r.json) {
    return {
      id: "F02a",
      title: "Compute catalogue and prices",
      status: "fail",
      detail: r.throttled ? "throttled (HTML interstitial)" : `HTML ${r.status}`,
      measurements: { status: r.status },
      evidence: r.text.slice(0, 400),
    };
  }

  const body = r.json as Record<string, unknown>;
  const available = Array.isArray(body.available_addons) ? body.available_addons : [];
  const compute = available.find(
    (a) => (a as Record<string, unknown>).type === "compute_instance",
  ) as Record<string, unknown> | undefined;
  const variants = Array.isArray(compute?.variants) ? compute.variants : [];

  const measurements: Record<string, string | number> = { status: r.status };
  for (const v of variants as Record<string, unknown>[]) {
    const id = String(v.identifier ?? v.name ?? "unknown");
    const price = (v.price ?? {}) as Record<string, unknown>;
    measurements[`${id}_usd_hr`] = hourlyRate(price.description);
    const meta = (v.meta ?? {}) as Record<string, unknown>;
    // The preview-branch guide quotes these per tier with no source.
    if (meta.memory_gb != null) measurements[`${id}_mem_gb`] = String(meta.memory_gb);
    if (meta.max_connections_direct != null) {
      measurements[`${id}_conn_direct`] = String(meta.max_connections_direct);
    }
    if (meta.max_connections_pooler != null) {
      measurements[`${id}_conn_pooler`] = String(meta.max_connections_pooler);
    }
  }

  const selected = Array.isArray(body.selected_addons) ? body.selected_addons : [];
  measurements.selected_count = selected.length;

  return {
    id: "F02a",
    title: "Compute catalogue and prices",
    status: "info",
    detail: `${variants.length} compute variants; ${selected.length} selected on this project`,
    measurements,
    evidence: JSON.stringify(body, null, 2).slice(0, 8000),
  };
}

async function apiKeys(ctx: Ctx): Promise<TestResult> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=false`);
  const keys = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  const names = keys.map((k) => String(k.name ?? "?")).sort();
  const types = [...new Set(keys.map((k) => String(k.type ?? "?")))].sort();

  // The provisioning trap recorded in AGENTS.md: new projects carry BOTH the
  // legacy JWTs and the newer sb_publishable_/sb_secret_ pair, so a script
  // that assumes one shape sends a non-JWT as a bearer and gets PGRST301.
  // That is a shape with a right answer, so this one asserts.
  const bothShapes = types.includes("legacy") && types.some((t) => t !== "legacy");

  return {
    id: "F02b",
    title: "API keys: both shapes present on a new project",
    status: r.status === 200 && bothShapes ? "pass" : "fail",
    detail: `${keys.length} keys: ${names.join(", ")}`,
    measurements: {
      status: r.status,
      key_count: keys.length,
      names: names.join("|"),
      types: types.join("|"),
    },
    evidence: JSON.stringify(keys, null, 2).slice(0, 2000),
  };
}

async function signingKeys(ctx: Ctx): Promise<TestResult> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/config/auth/signing-keys`);
  const body = r.json as Record<string, unknown> | undefined;
  const keys = Array.isArray(body?.keys) ? (body.keys as Record<string, unknown>[]) : [];
  const algos = [...new Set(keys.map((k) => String(k.algorithm ?? "?")))].sort();
  const statuses = keys.map((k) => `${String(k.algorithm)}:${String(k.status)}`).sort();

  return {
    id: "F02c",
    title: "Signing keys: algorithms and statuses on a new project",
    status: r.status === 200 ? "info" : "fail",
    // The consolidation guide states new projects sign with ES256 and demote
    // the legacy HS256 secret to previously_used. Recorded, not asserted:
    // the default is exactly the sort of thing that changes.
    detail: statuses.join(", ") || "none",
    measurements: {
      status: r.status,
      key_count: keys.length,
      algorithms: algos.join("|"),
      statuses: statuses.join("|"),
    },
    evidence: JSON.stringify(body ?? {}, null, 2).slice(0, 2000),
  };
}

async function perServiceHealth(ctx: Ctx): Promise<TestResult> {
  const services = ["auth", "db", "pooler", "realtime", "rest", "storage"];
  const q = services.map((s) => `services=${s}`).join("&");
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/health?${q}`);
  const arr = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];

  const measurements: Record<string, string | number> = { status: r.status, count: arr.length };
  for (const s of arr) measurements[String(s.name ?? "?")] = String(s.status ?? "?");

  // Load-bearing for both migration guides and the consolidation guide, all
  // of which now tell the reader to gate on this rather than on the
  // aggregate project status. If it stops reporting per service, that advice
  // silently becomes wrong.
  return {
    id: "F02d",
    title: "Health endpoint reports each service independently",
    status: r.status === 200 && arr.length >= 3 ? "pass" : "fail",
    detail: arr.map((s) => `${String(s.name)}=${String(s.status)}`).join(" "),
    measurements,
    evidence: r.text.slice(0, 1500),
  };
}

async function postgresVersion(ctx: Ctx): Promise<TestResult> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
  const body = (r.json ?? {}) as Record<string, unknown>;
  const db = (body.database ?? {}) as Record<string, unknown>;

  // "New projects land on the current platform default major (17 as of
  // 2026-07)" is a dated claim in the upgrade guide and the premise of its
  // Track B. This is the cheapest way to keep that date honest.
  return {
    id: "F02e",
    title: "Postgres major a new project lands on",
    status: r.status === 200 ? "info" : "fail",
    detail: `version=${String(db.version ?? "unknown")} region=${String(body.region ?? "?")}`,
    measurements: {
      status: r.status,
      pg_version: String(db.version ?? "unknown"),
      release_channel: String(db.release_channel ?? "unknown"),
      postgres_engine: String(db.postgres_engine ?? "unknown"),
      region: String(body.region ?? "unknown"),
      instance_size: String(body.instance_size ?? "unknown"),
    },
    evidence: JSON.stringify(body, null, 2).slice(0, 1500),
  };
}

const mod: TestModule = {
  id: "F02",
  title: "Project-scoped platform constants",
  where: "local",
  requires: ["pat"],
  async run(ctx) {
    if (!ctx.ref) {
      return {
        id: "F02",
        title: this.title,
        status: "skip",
        detail: "PVLAB_REF not set - run 'make apply' first",
      };
    }
    // Sequential, not Promise.all: the API answers concurrent probing with a
    // Cloudflare interstitial, and a throttled snapshot is worse than a slow
    // one because it looks like an absent field.
    const out: TestResult[] = [];
    for (const probe of [computeCatalogue, apiKeys, signingKeys, perServiceHealth, postgresVersion]) {
      out.push(await probe(ctx));
    }
    return out;
  },
};
export default mod;
