import { z } from "zod";

/**
 * The API client. There is no bespoke API server: every endpoint below is a
 * Postgres function that PostgREST exposes over HTTPS.
 *
 * `Content-Profile: demo` is mandatory on every call. PostgREST only exposes
 * `public` and `graphql_public` by default; the project config was widened to
 * include `demo`, and the header is what selects it per request. Omitting it
 * returns PGRST106 "Invalid schema: demo", which reads like a server
 * misconfiguration and is not one.
 *
 * The anon key is public by design - it identifies the anon role, and that role
 * can execute exactly seven read-only functions and select from no table at all.
 * Raw table access returns 42501. The functions are SECURITY DEFINER precisely
 * so anon never needs rights on the underlying document text.
 */
const URL_BASE = import.meta.env.PUBLIC_SUPABASE_URL;
const ANON = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!URL_BASE || !ANON) {
  throw new Error(
    "PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY must be set - copy .env.example to .env",
  );
}

async function rpc<T>(fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
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
    throw new Error(`DIAGNOSTIC: RPC ${fn} FAILED ${res.status} - ${body.slice(0, 200)}`);
  }
  // Parsed, not cast. The response crosses a trust boundary even when the
  // server is ours: a schema change ships a shape error here rather than an
  // undefined three components deeper in a render.
  return schema.parse(await res.json());
}

export const KINDS = ["nist_control", "usc", "cfr", "publaw"] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  nist_control: "CTRL",
  usc: "U.S.C.",
  cfr: "CFR",
  publaw: "PUB.L",
};

export const KIND_COLOR: Record<string, string> = {
  nist_control: "var(--color-kind-control)",
  usc: "var(--color-kind-usc)",
  cfr: "var(--color-kind-cfr)",
  publaw: "var(--color-kind-publaw)",
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

export const api = {
  stats: () => rpc("stats", {}, Stats),
  documents: () => rpc("documents", {}, z.array(DocumentRow)),
  search: (q: string, lim = 25) => rpc("search_entities", { q, lim }, z.array(Entity)),
  neighbourhood: (root: number, max_depth = 2, lim = 200) =>
    rpc("neighbourhood", { root, max_depth, lim }, z.array(Neighbour)),
  shortestPath: (src: number, dst: number) =>
    rpc("shortest_path", { src, dst }, z.array(PathHop)),
  provenance: (entity: number, lim = 20) =>
    rpc("provenance", { entity, lim }, z.array(Provenance)),
  components: (min_size = 2) => rpc("components", { min_size }, z.array(Component)),
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
