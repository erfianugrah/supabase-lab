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
  | "pgbench" // pgbench on PATH (postgresql*-contrib)
  | "openssl";

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
  pat?: string;
  region: string;
  endpointIps: string[];
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
  run(ctx: Ctx): Promise<TestResult | TestResult[]>;
}

/** Provenance travels with the results so a run is interpretable later. */
export interface RunArtifact {
  startedAt: string;
  finishedAt: string;
  where: Where;
  region: string;
  ref: string;
  labCommit?: string;
  toolVersions: Record<string, string>;
  results: TestResult[];
}
