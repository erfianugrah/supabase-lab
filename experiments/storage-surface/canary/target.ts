/**
 * What every SS03-SS05 canary command is told about the system under test.
 * Nothing in canary/ knows whether it is a managed project or the local
 * self-hosted stack: the TestModule builds a Target and passes it on stdin.
 *
 *   managed  hosts gateway https://<ref>.supabase.co and direct
 *            https://<ref>.storage.supabase.co; S3 credentials in the
 *            session-token form (access key id = project ref, secret = anon
 *            key, session token = service_role JWT)
 *   sh-*     one host, the Envoy gateway; S3 credentials are the stack's
 *            S3_PROTOCOL_ACCESS_KEY_ID / S3_PROTOCOL_ACCESS_KEY_SECRET
 */
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { Creds } from "./http.ts";

export interface Host {
  name: "gateway" | "direct";
  /** .../storage/v1 */
  rest: string;
  /** .../storage/v1/s3 */
  s3: string;
}

export interface Target {
  kind: string;
  managed: boolean;
  hosts: Host[];
  region: string;
  /** Service-level S3 credentials. */
  creds: Creds;
  /** Access key id for the session-token form with a user JWT (project ref, or the stack's tenant id). */
  sessionKeyId: string;
  anon: string;
  service: string;
  /** Secret values to scrub from anything returned. */
  secrets: string[];
}

export const gw = (t: Target): Host => t.hosts.find((h) => h.name === "gateway") ?? t.hosts[0]!;
/** Upload host: the direct storage host where one exists (the docs' advice for large files). */
export const up = (t: Target): Host => t.hosts.find((h) => h.name === "direct") ?? t.hosts[0]!;

export function s3c(t: Target, h: Host, creds: Creds = t.creds, extra: Partial<S3ClientConfig> = {}): S3Client {
  return new S3Client({ forcePathStyle: true, region: t.region, endpoint: h.s3, credentials: creds, maxAttempts: 1, ...extra });
}

export const restAuth = (t: Target, jwt = t.service) => ({ apikey: t.anon && jwt !== t.service ? t.anon : t.service, authorization: `Bearer ${jwt}` });

export function scrubber(t: Target): (s: string) => string {
  const vals = t.secrets.filter((v) => v && v.length >= 8).sort((a, b) => b.length - a.length);
  return (s: string) => {
    let o = s;
    for (const v of vals) o = o.split(v).join("<secret>");
    return o;
  };
}

export interface SdkOut {
  ok: boolean;
  status: number;
  code: string;
  msg: string;
  headers: Record<string, string>;
}

/** Run an SDK call; never throws. */
export async function sdk<T>(f: () => Promise<T>): Promise<SdkOut & { r?: T }> {
  try {
    const r = await f();
    const meta = (r as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return { ok: true, status: meta?.httpStatusCode ?? 0, code: "", msg: "", headers: {}, r };
  } catch (e) {
    const x = e as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } };
    return {
      ok: false,
      status: x.$metadata?.httpStatusCode ?? 0,
      code: x.Code ?? x.name ?? "Error",
      msg: String(x.message ?? "").replace(/\s+/g, " ").slice(0, 160),
      headers: x.$response?.headers ?? {},
    };
  }
}
