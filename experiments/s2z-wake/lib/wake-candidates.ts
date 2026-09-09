/**
 * One candidate waker per project.
 *
 * This is the whole reason the fan-out exists. An auto-paused project takes
 * DAYS of zero query activity to reach that state, and the moment something
 * wakes it the clock restarts - so a single project can answer exactly ONE
 * question per window. Testing twelve candidates serially would take twelve
 * windows. Testing them in parallel takes one, at the cost of twelve projects.
 *
 * `control` fires NOTHING, and is not padding: without it, a project observed
 * waking cannot be attributed to the call we made rather than to the platform
 * waking things on its own schedule. It is the only row that can distinguish
 * "our call woke it" from "it woke anyway".
 *
 * The data-plane candidates are sent UNAUTHENTICATED on purpose. What is being
 * measured is whether the request reaching the edge triggers a wake, not
 * whether it succeeds - and needing a key would mean reading one per project,
 * which is fine, but needing a probe TABLE would mean running a query, which
 * would reset the very clock under test.
 */
export type Fire =
  | { kind: "none" }
  | { kind: "mgmt"; verb: "GET" | "POST"; path: string; body?: unknown }
  | { kind: "dataplane"; path: string }
  | { kind: "tcp"; hostRole: "db" | "pooler"; port: number };

export interface Candidate {
  /** Short slug; becomes part of the project name so the fleet is legible. */
  key: string;
  /** What is being tested, in one line, for the report. */
  claim: string;
  fire: Fire;
}

export const CANDIDATES: Candidate[] = [
  {
    key: "control",
    claim: "nothing is fired - baseline that separates 'our call woke it' from 'it woke anyway'",
    fire: { kind: "none" },
  },
  {
    key: "dp-rest",
    claim: "a request to the project URL's REST path - the documented wake path for a hibernated project",
    fire: { kind: "dataplane", path: "/rest/v1/" },
  },
  {
    key: "dp-auth",
    claim: "a request to the Auth service on the project URL",
    fire: { kind: "dataplane", path: "/auth/v1/health" },
  },
  {
    key: "dp-func",
    claim: "a request to the Edge Functions gateway on the project URL",
    fire: { kind: "dataplane", path: "/functions/v1/" },
  },
  {
    key: "mg-project",
    claim: "GET /projects/{ref} - the cheapest control-plane read a polling platform would make",
    fire: { kind: "mgmt", verb: "GET", path: "/projects/{REF}" },
  },
  {
    key: "mg-health",
    claim: "GET /projects/{ref}/health - probing services could plausibly start them",
    fire: { kind: "mgmt", verb: "GET", path: "/projects/{REF}/health?services=db,rest,auth" },
  },
  {
    key: "mg-query-ro",
    claim: "POST /database/query/read-only - documented as NOT waking a suspended project; verify it",
    fire: { kind: "mgmt", verb: "POST", path: "/projects/{REF}/database/query/read-only", body: { query: "select 1" } },
  },
  {
    key: "mg-query",
    claim: "POST /database/query - the read-write twin of the above",
    fire: { kind: "mgmt", verb: "POST", path: "/projects/{REF}/database/query", body: { query: "select 1" } },
  },
  {
    key: "mg-context",
    claim: "GET /database/context - introspects the catalogs, so it must reach Postgres",
    fire: { kind: "mgmt", verb: "GET", path: "/projects/{REF}/database/context" },
  },
  {
    key: "mg-metrics",
    claim: "GET /analytics/endpoints/metrics - the scrape target is the instance itself",
    fire: { kind: "mgmt", verb: "GET", path: "/projects/{REF}/analytics/endpoints/metrics" },
  },
  {
    key: "mg-restart",
    claim: "POST /restart - if anything in the Management API starts compute, this is it",
    fire: { kind: "mgmt", verb: "POST", path: "/projects/{REF}/restart" },
  },
  {
    key: "tcp-pooler",
    claim: "a raw TCP connection to the pooler - documented as NOT waking a suspended project",
    fire: { kind: "tcp", hostRole: "pooler", port: 6543 },
  },
];

/** Fleet manifest lives OUTSIDE the repo: a project ref is an account identifier
 *  and `identifiers.test.ts` scans tracked and add-able files for that shape. */
export const FLEET_FILE =
  process.env.PVLAB_S2Z_FLEET_FILE ?? `${process.env.HOME}/.local/share/s2z-wake/fleet.tsv`;
