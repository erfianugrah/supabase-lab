/**
 * S3 client for one target, authenticated in the session-token form with the
 * user's own access token (access key id from the target config, secret = the
 * public anon key, session token = the user JWT), so storage RLS applies.
 * Credentials expire with the JWT and are re-read through Session.token().
 */
import { S3Client } from "@aws-sdk/client-s3";
import type { Session, TargetConfig } from "./ctx";
import { CkError } from "./errors";

export function s3For(t: TargetConfig, s: Session): S3Client {
  return new S3Client({
    forcePathStyle: true,
    region: t.s3.region,
    endpoint: t.s3.endpoint,
    maxAttempts: 3,
    // A stalled transfer must fail, not hang: 300 s per request, 30 s to connect.
    requestHandler: { requestTimeout: 300_000, connectionTimeout: 30_000 },
    // Integrity is the catalogue's job (per-chunk SHA-256); the endpoint does
    // not store object checksums, so the SDK's default CRC32 is not sent.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: async () => {
      const token = await s.token();
      return { accessKeyId: t.s3.accessKeyId, secretAccessKey: t.anonKey, sessionToken: token, expiration: new Date(s.expiresAtMs - 60_000) };
    },
  });
}

/** Wrap an SDK call so every failure is a typed StorageError carrying status and S3 code. */
export async function s3call<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const x = e as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    throw new CkError("StorageError", `${what}: ${x.Code ?? x.name ?? "Error"} ${String(x.message ?? "").slice(0, 120)}`, {
      status: x.$metadata?.httpStatusCode ?? 0,
      code: x.Code ?? x.name ?? "",
    });
  }
}
