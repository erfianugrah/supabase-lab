/**
 * The contract every test implements. Adding a test = adding one file that
 * default-exports a TestModule; the registry, runner, and report renderer are
 * generic over this and need no edits.
 */

/** Where a test has to execute from. */
export type Where = "runner" | "local";

/**
 * Capabilities a test needs. The runner gates on these and emits an explicit
 * skip with a reason, instead of tests hand-rolling "if empty then echo SKIP".
 */
export type Capability =
  | "db" // database reachable via the PHZ host
  | "endpoint" // PrivateLink endpoint exists (phase 2 applied)
  | "lambda" // probe Lambda deployed (enable_lambda = true)
  | "anon-key" // project anon key available
  | "pat" // Supabase management PAT available
  | "peer" // a second project ref is available (multi-project experiments)
  | "org" // at least one organization slug supplied
  | "pgbench" // pgbench on PATH (postgresql*-contrib)
  | "openssl"
  | "pooler" // pooler host supplied via PVLAB_ENDPOINT_POOLER
  | "second-vpc" // probe Lambda in a second, peered VPC (PVLAB_ENDPOINT_SECOND_VPC_LAMBDA) - local vantage only
  | "service-network" // VPC Lattice service-network DNS name resolvable (PVLAB_ENDPOINT_SERVICE_NETWORK_DNS) - runner vantage only
  | "direct-db"; // direct 5432 reachable from this vantage (IPv6 - runner only)

export type Status = "pass" | "fail" | "skip" | "info";

/**
 * One observation. `fail` is a legitimate outcome that gets recorded, not an
 * error to retry away - this suite measures an external system, it does not
 * drive it to green.
 */
export interface TestResult {
  id: string;
  title: string;
  status: Status;
  /** One line a human reads first. */
  detail?: string;
  /** Numbers/strings rendered as report table columns automatically. */
  measurements?: Record<string, number | string>;
  /** Raw command output, error text, or anything worth keeping verbatim. */
  evidence?: string;
  /** Set by the runner. */
  durationMs?: number;
}

export interface Ctx {
  /** Supabase project ref. */
  ref: string;
  /** db.<ref>.supabase.co - resolves to endpoint ENIs inside the VPC. */
  phzHost: string;
  /** Public API hostname (<ref>.supabase.co) - never carried by PrivateLink. */
  apiHost: string;
  dbPassword: string;
  anonKey?: string;
  serviceKey?: string;
  pat?: string;
  region: string;
  endpointIps: string[];
  /**
   * Other project refs this experiment spans, by role - `spoke`, `target`,
   * `hub`. Multi-project experiments outnumber single-project ones now, and
   * reading `process.env.X_SOMETHING_REF` inside a test put the run's shape
   * outside the context object that is supposed to describe it. Populated
   * from `PVLAB_PEER_<ROLE>`, lowercased.
   */
  peers: Record<string, string>;
  /** Organization slugs under test, from `PVLAB_ORG_SLUGS` (comma-separated). */
  orgSlugs: string[];
  /**
   * Organizations by ROLE - `pro`, `team`, `free` - from `PVLAB_ORG_<ROLE>`.
   * Self-provisioning modules that need "a Pro org" or "the Free org" read
   * `ctx.orgs.pro` and skip with a reason when it is absent. Until 2026-09-02
   * eighteen modules carried the slugs as constants in source; a public repo
   * is the wrong place for an account identifier, and the identifiers test
   * scans prose for exactly that shape.
   */
  orgs: Record<string, string>;
  /**
   * Probe targets for this run, by role - `pooler`, `custom_domain`, `replica`.
   * Populated from `PVLAB_ENDPOINT_<NAME>`, lowercased. Same reasoning as
   * `peers`: a test that reads process.env directly puts the run's shape
   * outside the context object whose job is to describe it. An env var set to
   * empty counts as absent, because a Makefile interpolating a missing tofu
   * output exports exactly that.
   */
  endpoints: Record<string, string>;
  mgmtBase?: string;
  apiHostSuffix?: string;
  capabilities: Set<Capability>;
  /** Where this process is running, so `where`-filtering works. */
  where: Where;
  log: (msg: string) => void;
}

export interface TestModule {
  id: string;
  title: string;
  where: Where;
  requires?: Capability[];
  /**
   * Mutates or interrupts the environment (restarts, replacements, deletes).
   * Deferred until every read-only test has run, and only executed when the
   * runner is invoked with destructive mode enabled.
   */
  destructive?: boolean;
  /**
   * Which experiment dir this module came from. Stamped by gen-registry
   * (never set by hand) - module ids collide across experiments, and this is
   * what lets `--experiment` scope a run to one dir.
   */
  experiment?: string;
  run(ctx: Ctx): Promise<TestResult | TestResult[]>;
}

/** Provenance travels with the results so a run is interpretable later. */
export interface RunArtifact {
  startedAt: string;
  finishedAt: string;
  where: Where;
  region: string;
  ref: string;
  /**
   * Which experiment produced this. One registry now carries every
   * experiment's tests, so the report cannot assume it is the PrivateLink one.
   */
  experiment?: string;
  labCommit?: string;
  toolVersions: Record<string, string>;
  results: TestResult[];
}
