import { z } from "zod";

/**
 * The API client. There is no bespoke API server: every endpoint below is a
 * Postgres function that PostgREST exposes over HTTPS.
 *
 * `Content-Profile: demo` is mandatory on every call. Postgrest only exposes
 * `public` and `graphql_public` by default; the project config was widened to
 * include `demo`, and the header is what selects it per request. Omitting it
 * returns PGRST1                106 "Invalid schema: demo", which reads like a server
 * misconfiguration.
 *
 * The anon key is public by design - it identifies the anon role, and that role
 * can execute exactly seven read-only functions and select from no table at all.
 * Raw table access returns 42501. The functions are SECURITY DEFINER precisely
 * so anon never needs rights on the underlying document text.
 */
/**
 * Narrow at the point of definition, not with a module-level guard.
 *
 * `import.meta.env.X` is typed `string | undefined`, and a top-level
 * `if (!ANON) throw` does NOT narrow the const inside a function body - control
 * flow analysis does enough to narrow it here.
 *
 * A helper that throws and RETURNS `string` narrows once, at the binding.
 */
function requireEnv(name: string, value:
string | undefined): string {
  if (!value) {
    throw new Error(`${name} must be set - copy .env.example to .env and fill it in`);
  }
  return value;
}

const URL_BASE = requireEnv("PUBLIC_SUPABASE_URL", import.meta.env.PUBLIC_SUPABASE_URL);
const ANON = requireEnv("PUBLIC_SUPABASE_ANON_KEY", import.meta.env.PUBLIC_SUPABASE_ANON_KEY);

// Production builds read through the Worker's caching proxy at the same
// origin (edge HITs in single-digit ms, and the demo keeps answering STALE
// responses if the disposable database is down). `astro dev` has no worker,
// so local development talks to PostgREST directly.
const API_BASE = import.meta.env.PROD ? "" : URL_BASE;

async function rpc<T>(fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${API_BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      "Content-Type": "application/json",
      "Content-Profile": "demo",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DIAGNOSTIC: RPC ${fn} FAILED ${res.status} - ${body.slice(
  0, 200)}`);
  }
  // Parsed, not cast. The response crosses a trust boundary even if the
  // server is ours: a schema change ships a shape error here rather than an
  // undefined three components deeper in a render.
  return schema.parse(await res.json());
}

export const KINDS = ["nist_control", "usc", "cfr", "publaw", "person", "org", "abn"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  nist_control: "CTRL",
  usc: "U.S.C.",
  cfr: "CFR",
  publaw: "PUB.L",
  person: "PERSON",
  org: "ORG",
  abn: "ABN",
};

export const KIND_COLOR: Record<string, string> = {
  nist_control: "var(--color-kind-control)",
  usc: "var(--color-kind-usc)",
  cfr: "var(--color-kind-cfr)",
  publaw: "var(--color-kind-publaw)",
  person: "var(--color-kind-person)",
  org: "var(--color-kind-org)",
  abn: "var(--color-kind-abn)",
};

const Stats = z.object({
  documents: z.number(),
  entities: z.number(),
  mentions: z.number(),
  edges: z.number(),
  by_kind: z.record(z.string(), z.number()),
});
export type Stats = z.infer<typeof Stats>;

const DocumentRow = z.object({
  slug: z.string(),
  genre: z.string(),
  source_bytes: z.number(),
  extracted_bytes: z.number(),
  extract_ratio: z.coerce.number().nullable(),
  entities: z.number(),
  mentions: z.number(),
});
export type DocumentRow = z.infer<typeof DocumentRow>;

const Entity = z.object({
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  mentions_count: z.number(),
  docs_count: z.number(),
  score: z.number(),
});
export type Entity = z.infer<typeof Entity>;

const Neighbour = z.object({
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  depth: z.number(),
  via_doc: z.string().nullable(),
  weight: z.number(),
});
export type Neighbour = z.infer<typeof Neighbour>;

const PathHop = z.object({
  seq: z.number(),
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  cost: z.number(),
  agg_cost: z.number(),
});
export type PathHop = z.infer<typeof PathHop>;

const Provenance = z.object({
  doc_slug: z.string(),
  genre: z.string(),
  char_offset: z.number(),
  snippet: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

const Component = z.object({
  component: z.number(),
  size: z.number(),
  sample_labels: z.string().nullable(),
});
export type Component = z.infer<typeof Component>;

const SearchResult = z.object({
  slug: z.string(),
  genre: z.string(),
  source_bytes: z.number(),
  rank: z.number(),
  headline: z.string(),
});
export type SearchResult = z.infer<typeof SearchResult>;

const CrossDocEntity = z.object({
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  mentions_count: z.number(),
  docs_count:
    z.number(),
  docs: z.array(z.string()),
});
export type CrossDocEntity = z.infer<typeof CrossDocEntity>;

const EntityTimelineRow = z.object({
  // US federal mentions carry no document date; the timeline is nulls-last
  // by design, so this parses null rather than failing the whole row set.
  doc_date: z.string().nullable(),
  doc_slug: z.string(),
  genre: z.string(),
  char_offset: z.number(),
  snippet: z.string(),
});
export type EntityTimelineRow = z.infer<typeof EntityTimelineRow>;

const NeighbourhoodAsAtRow = z.object({
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  depth: z.number(),
  via_doc: z.string().nullable(),
  weight: z.number(),
});
export type NeighbourhoodAsAtRow = z.infer<typeof NeighbourhoodAsAtRow>;

const BridgesAsAtRow = z.object({
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  mentions_count: z.number(),
  docs_count: z.number(),
  docs: z.array(z.string()),
});
export type BridgesAsAtRow = z.infer<typeof BridgesAsAtRow>;

const EntityRegistryIdRow = z.object({
  id: z.number(),
  label: z.string(),
  norm: z.string(),
  docs: z.array(z.string()),
});
export type EntityRegistryIdRow = z.infer<typeof EntityRegistryIdRow>;

const SubgraphEdge = z.object({
  id: z.number(),
  kind: z.string(),
  source: z.number(),
  target: z.number(),
  weight: z.number(),
  doc_slug: z.string(),
});
export type SubgraphEdge = z.infer<typeof SubgraphEdge>;

// The node rows are exactly neighbourhood() rows (subgraph() wraps it).
const Subgraph = z.object({
  root: z.number(),
  nodes: z.array(Neighbour),
  edges: z.array(SubgraphEdge),
});
export type Subgraph = z.infer<typeof Subgraph>;

const EntityRow = z.object({
  id: z.number(),
  kind: z.string(),
  label: z.string(),
  mentions_count: z.number(),
  docs_count: z.number(),
});
export type EntityRow = z.infer<typeof EntityRow>;

export const api = {
  stats: () => rpc("stats", {}, Stats),
  documents: () => rpc("documents", {}, z.array(DocumentRow)),
  search: (q: string, lim = 25) =>
    rpc("search_entities", { q, lim }, z.array(Entity)),
  neighbourhood: (root: number, max_depth = 2, lim = 200) =>
    rpc("neighbourhood", { root, max_depth, lim }, z.array(Neighbour)),
  shortestPath: (src: number, dst: number) =>
    rpc("shortest_path", { src, dst }, z.array(PathHop)),
  provenance: (entity: number, lim = 20) =>
    rpc("provenance", { entity, lim }, z.array(Provenance)),
  components: (min_s = 2) =>
    rpc("components", { min_size: min_s }, z.array(Component)),
  searchDocuments: (q: string, lim = 10) =>
    rpc("search_documents", { q, lim }, z.array(SearchResult)),
  crossDocumentEntities: (lim = 50) =>
    rpc("cross_document_entities", { lim }, z.array(CrossDocEntity)),
  entityTimeline: (entity: number, lim?: number) =>
    rpc("entity_timeline", { p_entity: entity, p_lim: lim },
      z.array(EntityTimelineRow)),
  neighbourhoodAsAt: (root: number, as_of: string, depth = 2, lim = 200) =>
    rpc("neighbourhood_as_at", {
      p_root: root,
      p_as_of: as_of,
      p_max_depth: depth,
      p_lim: lim,
    }, z.array(NeighbourhoodAsAtRow)),
  bridgesAsAt: (as_of: string, lim = 50) =>
    rpc("bridges_as_at", { p_as_of: as_of, p_lim: lim },
      z.array(BridgesAsAtRow)),
  entityRegistryIds: (entity: number) =>
    rpc("entity_registry_ids", { p_entity: entity },
      z.array(EntityRegistryIdRow)),
  subgraph: (root: number, maxDepth = 2, lim = 120) =>
    rpc("subgraph", { root, max_depth: maxDepth, lim }, Subgraph),
  entityGet: (entity: number) =>
    rpc("entity_get", { p_entity: entity }, z.array(EntityRow)),
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (
    n < 1024 * 1024
  )
    return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
