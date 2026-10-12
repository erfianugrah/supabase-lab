/**
 * Minimal SigV4 (header form) for raw S3 requests whose error BODY the suite
 * needs verbatim (CK12): the AWS SDK turns an error into an exception and
 * drops the XML. Same approach as storage-surface canary/http.ts, copied so
 * this experiment does not import another experiment's files. Paths are
 * signed exactly as sent; callers use keys that need no encoding.
 */
import { createHash, createHmac } from "node:crypto";
import { http, type Resp } from "./ckrun";

export interface S3Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

export function sign(method: string, url: string, headers: Record<string, string>, body: string, c: S3Creds, region: string): Record<string, string> {
  const u = new URL(url);
  const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const ph = sha(body);
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  h.host = u.host;
  h["x-amz-date"] = date;
  h["x-amz-content-sha256"] = ph;
  if (c.sessionToken) h["x-amz-security-token"] = c.sessionToken;
  const names = Object.keys(h).sort();
  const q = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canon = [method, u.pathname, q, names.map((n) => `${n}:${String(h[n]).trim()}\n`).join(""), names.join(";"), ph].join("\n");
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", date, scope, sha(canon)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date.slice(0, 8)), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(sts).digest("hex");
  delete h.host;
  h.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  return h;
}

export function s3raw(endpoint: string, path: string, c: S3Creds, region: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  const method = o.method ?? "GET";
  const url = `${endpoint}${path}`;
  const body = o.body ?? "";
  return http(url, { method, headers: sign(method, url, o.headers ?? {}, body, c, region), body: method === "GET" || method === "HEAD" ? undefined : body });
}
