/**
 * Regenerate experiments/s2z-wake/lib/surface.ts's endpoint list from the
 * published Management API OpenAPI document.
 *
 * The list has to be DERIVED. The F05 method note in experiments/platform-facts
 * records why: an earlier investigation concluded "the API cannot do X" after
 * probing only the endpoints whose path contained X's noun, and was wrong
 * because the lever lived on a differently-named path. A hand-maintained list
 * of "the endpoints we thought of" reintroduces exactly that, silently, as the
 * document grows.
 *
 * Usage:
 *   bun harness/scripts/gen-surface.ts            # production document
 *   SPEC=https://api.supabase.green/api/v1-json bun harness/scripts/gen-surface.ts
 *
 * Prints the PARAMLESS_GETS array body on stdout, plus a summary on stderr, so
 * a drift check is a diff rather than a rewrite. It deliberately does not edit
 * the file in place: the ORDER in surface.ts is meaningful (least-likely-to-wake
 * first) and is a judgement the document cannot express.
 */
const SPEC = process.env.SPEC ?? "https://api.supabase.com/api/v1-json";
const VERBS = ["get", "post", "put", "patch", "delete"] as const;

const res = await fetch(SPEC, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) {
  console.error(`spec fetch failed: HTTP ${res.status}`);
  process.exit(1);
}
const spec = (await res.json()) as { paths?: Record<string, Record<string, unknown>> };
const paths = spec.paths ?? {};

let total = 0;
const projectScoped: string[] = [];
const paramless: string[] = [];
for (const [path, item] of Object.entries(paths)) {
  for (const verb of VERBS) {
    if (!item[verb]) continue;
    total++;
    if (!path.startsWith("/v1/projects/{ref}")) continue;
    projectScoped.push(`${verb.toUpperCase()} ${path}`);
    // Only {ref} in the path => callable with no setup.
    if (verb === "get" && !path.replace("{ref}", "").includes("{")) {
      paramless.push(path.replace("/v1/projects/{ref}", ""));
    }
  }
}
paramless.sort();

console.error(`spec:            ${SPEC}`);
console.error(`operations:      ${total}`);
console.error(`project-scoped:  ${projectScoped.length}`);
console.error(`parameter-free GETs: ${paramless.length}`);
console.error(`\nDiff this against PARAMLESS_GETS in experiments/s2z-wake/lib/surface.ts.`);
console.error(`Ordering in that file is deliberate (least-likely-to-wake first); keep it.`);

console.log("export const PARAMLESS_GETS: string[] = [");
for (const p of paramless) console.log(`  ${JSON.stringify(p)},`);
console.log("];");

// ---------------------------------------------------------------------------
// Accounting. The experiment claims to cover "the surface", so the numbers have
// to add up to the document's own total or the claim is soft. Any operation
// that is neither swept nor declared unreachable is printed by name - that is
// the drift signal when the document grows.
// ---------------------------------------------------------------------------
const { PARAMLESS_GETS } = await import("../../experiments/s2z-wake/lib/surface.js");
const { WRITE_OPS, UNREACHABLE } = await import("../../experiments/s2z-wake/lib/write-ops.js");

const key = (v: string, p: string) => `${v.toUpperCase()} ${p}`;
const everything = new Set<string>();
for (const [path, item] of Object.entries(paths)) {
  for (const verb of VERBS) if (item[verb]) everything.add(key(verb, path));
}

const covered = new Set<string>();
for (const ep of PARAMLESS_GETS) covered.add(key("get", `/v1/projects/{ref}${ep}`));
// write-ops paths are written with {REF}/{ORG} and concrete ids; normalise back
// to the document's own parameter names so the two sets are comparable.
const norm = (p: string) =>
  `/v1${p}`
    .replace(/\{REF\}/g, "{ref}")
    .replace(/\{ORG\}/g, "{slug}")
    .replace(/\/v1\/projects\/\{ref\}\/api-keys\/\{API_KEY_ID\}/, "/v1/projects/{ref}/api-keys/{id}")
    .replace(/\{SIGNING_KEY_ID\}/g, "{id}")
    .replace(/\{SSO_ID\}/g, "{provider_id}")
    .replace(/\{TPA_ID\}/g, "{tpa_id}")
    .replace(/\{FUNC_SLUG\}/g, "{function_slug}")
    .replace(/\{MIGRATION_VERSION\}/g, "{version}")
    .replace(/\{BRANCH_ID\}/g, "{branch_id_or_ref}")
    .replace(/\{RUN_ID\}/g, "{run_id}")
    .replace(/\{CLAIM_TOKEN\}/g, "{token}")
    .replace(/\{INVITE_ID\}/g, "{invite_id}")
    .replace(/\/database\/jit\/00000000-0000-0000-0000-000000000000$/, "/database/jit/{user_id}")
    .replace(/\/billing\/addons\/ci_micro$/, "/billing/addons/{addon_variant}")
    .replace(/\/branches\/pvlab-probe$/, "/branches/{name}")
    .replace(/\?.*$/, "");
for (const op of WRITE_OPS) covered.add(key(op.verb, norm(op.path)));
for (const u of UNREACHABLE) covered.add(key(u.verb, u.path));

const uncovered = [...everything].filter((k) => !covered.has(k)).sort();
const phantom = [...covered].filter((k) => !everything.has(k)).sort();

console.error(`\n--- accounting ---`);
console.error(`document operations : ${everything.size}`);
console.error(`Z01 parameter-free GETs: ${PARAMLESS_GETS.length}`);
console.error(`Z02 op table         : ${WRITE_OPS.length} (${WRITE_OPS.filter((o) => o.terminal).length} terminal)`);
console.error(`declared unreachable : ${UNREACHABLE.length}`);
console.error(`covered (unique)     : ${covered.size}`);
console.error(`UNCOVERED            : ${uncovered.length}`);
for (const k of uncovered) console.error(`   uncovered: ${k}`);
console.error(`in tables but NOT in the document (stale): ${phantom.length}`);
for (const k of phantom) console.error(`   stale: ${k}`);
