/**
 * The named-key leg of the auth matrix (ER03): the colon syntax
 * `publishable:<name>` / `secret:<name>`, the wildcard `:*`, a name that is not
 * configured, and the bare modes against a project that holds a second key of
 * each kind. Expectations are the package docs' claims (docs/auth-modes.md,
 * docs/error-handling.md, docs/security.md of @supabase/server 1.9.1), kept
 * apart from the measured cells as in matrix.ts.
 *
 * Key names used on the project: the platform's own `default` keys plus one
 * extra publishable key named `web_app` and one extra secret key named
 * `automations` (names from the package README). The docs' shorter example
 * `web` is refused by the Management API (names need 4 or more characters,
 * ER03 run of 2026-10-23); ER03 records that refusal.
 */
export const DOCS_SHORT_NAME = "web";
export const EXTRA_PUBLISHABLE = "web_app";
export const EXTRA_SECRET = "automations";
/** A name no key on the project carries. */
export const MISSING_NAME = "nokey";

/**
 * Every auth option the servers expose, by id. The base five are the ER01
 * modes; the n_* ids are the named-key forms. Both the Bun server and the
 * Edge Function source take this table as data, so the two cannot drift.
 */
export const AUTH_TABLE: Record<string, string | string[]> = {
  none: "none",
  user: "user",
  secret: "secret",
  publishable: "publishable",
  user_secret: ["user", "secret"],
  n_pub_bare: "publishable",
  n_pub_named: `publishable:${EXTRA_PUBLISHABLE}`,
  n_pub_any: "publishable:*",
  n_pub_missing: `publishable:${MISSING_NAME}`,
  n_sec_bare: "secret",
  n_sec_named: `secret:${EXTRA_SECRET}`,
  n_sec_any: "secret:*",
  n_sec_missing: `secret:${MISSING_NAME}`,
  n_user_or_pub_named: ["user", `publishable:${EXTRA_PUBLISHABLE}`],
  n_pub_missing_or_sec: [`publishable:${MISSING_NAME}`, "secret"],
};

export const NAMED_MODES = [
  "n_pub_bare",
  "n_pub_named",
  "n_pub_any",
  "n_pub_missing",
  "n_sec_bare",
  "n_sec_named",
  "n_sec_any",
  "n_sec_missing",
  "n_user_or_pub_named",
  "n_pub_missing_or_sec",
] as const;
export type NamedMode = (typeof NAMED_MODES)[number];

export const NAMED_CREDENTIALS = [
  "pub_default",
  "pub_named",
  "sec_default",
  "sec_named",
  "unknown_secret",
  "user_jwt",
  "user_jwt_pub_named",
  "no_credentials",
] as const;
export type NamedCredential = (typeof NAMED_CREDENTIALS)[number];

export interface NamedKeys {
  pubDefault: string;
  pubNamed: string;
  secDefault: string;
  secNamed: string;
  /** A real, current access token from the project's Auth. */
  user: string;
}

export function namedHeaders(cred: NamedCredential, k: NamedKeys): Record<string, string> {
  switch (cred) {
    case "pub_default":
      return { apikey: k.pubDefault };
    case "pub_named":
      return { apikey: k.pubNamed };
    case "sec_default":
      return { apikey: k.secDefault };
    case "sec_named":
      return { apikey: k.secNamed };
    case "unknown_secret":
      return { apikey: `sb_secret_${"x".repeat(31)}` };
    case "user_jwt":
      return { Authorization: `Bearer ${k.user}` };
    case "user_jwt_pub_named":
      return { apikey: k.pubNamed, Authorization: `Bearer ${k.user}` };
    case "no_credentials":
      return {};
  }
}

const R = (...c: NamedCredential[]) => new Set<NamedCredential>(c);
const ALL = R(...NAMED_CREDENTIALS);
const minus = (s: Set<NamedCredential>, ...c: NamedCredential[]) => new Set([...s].filter((x) => !c.includes(x)));

/** Cells the docs say reach the handler. */
const RAN: Record<NamedMode, Set<NamedCredential>> = {
  // "Bare `publishable` matches only the `default` key"
  n_pub_bare: R("pub_default"),
  // "Only accept the "web" publishable key"
  n_pub_named: R("pub_named"),
  // "Accept any publishable key"
  n_pub_any: R("pub_default", "pub_named"),
  // NO_KEYS_CONFIGURED: "that mode can never match any request"
  n_pub_missing: R(),
  n_sec_bare: R("sec_default"),
  n_sec_named: R("sec_named"),
  n_sec_any: R("sec_default", "sec_named"),
  n_sec_missing: R(),
  // "Accepts either a valid JWT or the "web" publishable key"
  n_user_or_pub_named: R("user_jwt", "user_jwt_pub_named", "pub_named"),
  // "With auth: ['publishable:mobile', 'secret'], a valid secret key still succeeds"
  n_pub_missing_or_sec: R("sec_default"),
};

/**
 * Cells the docs say are refused. The user-token-plus-named-publishable cell
 * in the publishable-only modes is left out: the docs do not say whether a
 * publishable-only mode reads the bearer at all.
 */
const REFUSE: Record<NamedMode, Set<NamedCredential>> = {
  n_pub_bare: minus(ALL, "pub_default", "user_jwt_pub_named"),
  n_pub_named: minus(ALL, "pub_named", "user_jwt_pub_named"),
  n_pub_any: minus(ALL, "pub_default", "pub_named", "user_jwt_pub_named"),
  n_pub_missing: ALL,
  n_sec_bare: minus(ALL, "sec_default"),
  n_sec_named: minus(ALL, "sec_named"),
  n_sec_any: minus(ALL, "sec_default", "sec_named"),
  n_sec_missing: ALL,
  n_user_or_pub_named: minus(ALL, "user_jwt", "user_jwt_pub_named", "pub_named"),
  n_pub_missing_or_sec: minus(ALL, "sec_default"),
};

export type Expectation = "ran" | "refuse" | "undoc";

export function namedExpected(mode: NamedMode, cred: NamedCredential): Expectation {
  if (RAN[mode].has(cred)) return "ran";
  if (REFUSE[mode].has(cred)) return "refuse";
  return "undoc";
}

export function namedVerdict(mode: NamedMode, cred: NamedCredential, ran: boolean): "match" | "MISMATCH" | "undoc" {
  const e = namedExpected(mode, cred);
  if (e === "undoc") return "undoc";
  return (e === "ran") === ran ? "match" : "MISMATCH";
}

/** Replace every known key or token value in a response body by its label, before it is recorded. */
export function scrub(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [label, value] of Object.entries(secrets)) {
    if (value && value.length >= 8) out = out.split(value).join(`<${label}>`);
  }
  return out;
}

/** Cells (by key) whose text differs between two passes over the same target. */
export function passDiff(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}
