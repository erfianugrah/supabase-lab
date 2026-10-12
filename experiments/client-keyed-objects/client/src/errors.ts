/**
 * Typed failures. Every read or upload that cannot prove what it returns
 * fails closed with one of these codes; callers (and the CK suite) branch on
 * `code`, never on message text.
 */
export type CkErrorCode =
  | "UnknownTenant" // tenant not in the static directory
  | "AuthError" // sign-in / refresh refused
  | "KeyServiceUnavailable" // key service unreachable (network error or 5xx)
  | "KeyServiceDenied" // key service refused the caller (401/403)
  | "KeyServiceError" // any other key service answer
  | "CatalogueError" // Data API refused or failed
  | "StorageError" // Storage (REST, S3 or TUS) refused or failed
  | "ChunkHashMismatch" // stored ciphertext chunk differs from the catalogue hash
  | "ChunkAuthFailed" // AES-GCM tag did not verify (tamper, reorder, wrong asset)
  | "TruncatedObject" // fewer ciphertext bytes than the catalogue says exist
  | "RangeNotHonoured" // server answered a ranged GET with something else
  | "IntegrityError"; // full-read plaintext SHA-256 differs from the catalogue

export class CkError extends Error {
  constructor(
    public code: CkErrorCode,
    message: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "CkError";
  }
}

export const isCk = (e: unknown): e is CkError => e instanceof CkError;
