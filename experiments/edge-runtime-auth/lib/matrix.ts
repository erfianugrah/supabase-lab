/**
 * The auth-mode x credential matrix as data: which credential presentations
 * are sent, which modes are probed, and what the package docs say each cell
 * should do. The expectations are the DOCS' claims (docs/auth-modes.md in the
 * package), kept apart from the measured cells so a mismatch is a finding
 * and an `undoc` cell is a measurement the docs do not cover.
 */
export const MODES = ["none", "user", "secret", "publishable", "user_secret"] as const;
export type Mode = (typeof MODES)[number];

export const CREDENTIALS = [
  "legacy_anon",
  "legacy_service_role",
  "publishable",
  "publishable_bearer",
  "secret",
  "unknown_secret",
  "user_jwt",
  "user_jwt_pub",
  "user_jwt_secret",
  "expired_jwt_pub",
  "tpa_jwt_pub",
  "foreign_jwt_pub",
  "legacy_hs256_jwt_pub",
  "no_credentials",
] as const;
export type Credential = (typeof CREDENTIALS)[number];

export interface TokenBag {
  anon: string;
  service: string;
  publishable: string;
  secret: string;
  /** A real, current access token from the project's Auth. */
  user: string;
  /** A real access token from the project's Auth whose exp has passed. */
  expired: string;
  /** Signed by an issuer registered as third-party auth on the project. */
  tpa: string;
  /** Signed by an ES256 key no project trusts. */
  foreign: string;
  /** HS256 under the project's shared JWT secret, no kid. */
  hs256: string;
}

export function headersFor(cred: Credential, t: TokenBag): Record<string, string> {
  const bearer = (v: string) => ({ Authorization: `Bearer ${v}` });
  switch (cred) {
    case "legacy_anon":
      return { apikey: t.anon, ...bearer(t.anon) };
    case "legacy_service_role":
      return { apikey: t.service, ...bearer(t.service) };
    case "publishable":
      return { apikey: t.publishable };
    case "publishable_bearer":
      return { apikey: t.publishable, ...bearer(t.publishable) };
    case "secret":
      return { apikey: t.secret };
    case "unknown_secret":
      return { apikey: `sb_secret_${"x".repeat(31)}` };
    case "user_jwt":
      return bearer(t.user);
    case "user_jwt_pub":
      return { apikey: t.publishable, ...bearer(t.user) };
    case "user_jwt_secret":
      return { apikey: t.secret, ...bearer(t.user) };
    case "expired_jwt_pub":
      return { apikey: t.publishable, ...bearer(t.expired) };
    case "tpa_jwt_pub":
      return { apikey: t.publishable, ...bearer(t.tpa) };
    case "foreign_jwt_pub":
      return { apikey: t.publishable, ...bearer(t.foreign) };
    case "legacy_hs256_jwt_pub":
      return { apikey: t.publishable, ...bearer(t.hs256) };
    case "no_credentials":
      return {};
  }
}

export type Expectation = "ran" | "refuse" | "undoc";

const R = (...c: Credential[]) => new Set<Credential>(c);

const RAN: Record<Mode, Set<Credential>> = {
  none: R("no_credentials", "publishable", "secret", "user_jwt", "user_jwt_pub", "user_jwt_secret"),
  user: R("user_jwt", "user_jwt_pub", "user_jwt_secret"),
  secret: R("secret"),
  publishable: R("publishable"),
  user_secret: R("user_jwt", "user_jwt_pub", "user_jwt_secret", "secret"),
};

const REFUSE: Record<Mode, Set<Credential>> = {
  none: R(),
  user: R("legacy_anon", "legacy_service_role", "legacy_hs256_jwt_pub", "expired_jwt_pub", "foreign_jwt_pub", "no_credentials", "publishable", "secret", "unknown_secret"),
  secret: R("legacy_anon", "legacy_service_role", "no_credentials", "publishable", "unknown_secret", "user_jwt"),
  publishable: R("legacy_anon", "legacy_service_role", "no_credentials", "secret", "unknown_secret", "user_jwt"),
  user_secret: R("legacy_anon", "legacy_service_role", "legacy_hs256_jwt_pub", "expired_jwt_pub", "foreign_jwt_pub", "no_credentials", "publishable", "unknown_secret"),
};

/** What auth-modes.md says this cell does; `undoc` where the docs are silent or ambiguous. */
export function expected(mode: Mode, cred: Credential): Expectation {
  if (RAN[mode].has(cred)) return "ran";
  if (REFUSE[mode].has(cred)) return "refuse";
  return "undoc";
}

/** Compare one observed cell with the docs. Returns "match", "MISMATCH" or "undoc". */
export function verdict(mode: Mode, cred: Credential, ran: boolean): "match" | "MISMATCH" | "undoc" {
  const e = expected(mode, cred);
  if (e === "undoc") return "undoc";
  return (e === "ran") === ran ? "match" : "MISMATCH";
}
