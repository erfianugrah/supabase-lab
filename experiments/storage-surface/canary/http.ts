/**
 * Raw HTTP for the SS03-SS05 battery, on node:http(s) rather than fetch:
 * fetch (Bun's and undici's) decompresses `Content-Encoding: gzip` bodies and
 * adds its own `Accept-Encoding`, which would hide exactly what SS03k asks
 * (does the edge change the bytes or drop Content-Length). Bodies are hashed
 * as they stream; only the first `keep` bytes are kept as text.
 *
 * Also a minimal SigV4 header signer for S3 requests the SDK will not send
 * as-is (raw conditional headers, SSE headers over plain HTTP, error bodies
 * read verbatim). Paths are signed exactly as sent; callers use keys with no
 * characters that need encoding.
 */
import http from "node:http";
import https from "node:https";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";

export interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface RawResp {
  status: number;
  headers: Record<string, string>;
  bytes: number;
  sha256: string;
  text: string;
  ms: number;
  /** Time to the response headers. */
  ttfbMs?: number;
  error?: string;
}

export type Body = Buffer | string | { file: string; start?: number; end?: number } | undefined;

const agentHttp = new http.Agent({ keepAlive: true });
const agentHttps = new https.Agent({ keepAlive: true });

export function raw(
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: Body; keep?: number; timeoutMs?: number } = {},
): Promise<RawResp> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    const b = o.body;
    if (typeof b === "string" || Buffer.isBuffer(b)) headers["content-length"] ??= String(Buffer.byteLength(b));
    else if (b && "file" in b && b.end !== undefined) headers["content-length"] ??= String(b.end - (b.start ?? 0) + 1);
    const req = mod.request(
      u,
      { method: o.method ?? "GET", headers, agent: u.protocol === "https:" ? agentHttps : agentHttp },
      (res) => {
        const ttfb = performance.now() - t0;
        const h = createHash("sha256");
        let bytes = 0;
        const keep = o.keep ?? 2048;
        const kept: Buffer[] = [];
        let keptLen = 0;
        res.on("data", (d: Buffer) => {
          h.update(d);
          bytes += d.length;
          if (keptLen < keep) {
            kept.push(d.subarray(0, keep - keptLen));
            keptLen += Math.min(d.length, keep - keptLen);
          }
        });
        res.on("end", () => {
          const hs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) hs[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          resolve({ status: res.statusCode ?? 0, headers: hs, bytes, sha256: h.digest("hex"), text: Buffer.concat(kept).toString("latin1"), ms: performance.now() - t0, ttfbMs: ttfb });
        });
        res.on("error", (e) => resolve({ status: res.statusCode ?? 0, headers: {}, bytes, sha256: "", text: "", ms: performance.now() - t0, error: String(e.message) }));
      },
    );
    req.setTimeout(o.timeoutMs ?? 600_000, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, headers: {}, bytes: 0, sha256: "", text: "", ms: performance.now() - t0, error: String(e.message).slice(0, 200) }));
    if (b && typeof b === "object" && !Buffer.isBuffer(b) && "file" in b) createReadStream(b.file, { start: b.start, end: b.end }).pipe(req);
    else req.end(b);
  });
}

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

/** Sign a request with SigV4 (header form). Every header passed is signed. */
export function sigv4(
  method: string,
  url: string,
  headers: Record<string, string>,
  /** The body, or a literal payload-hash marker such as UNSIGNED-PAYLOAD. */
  payload: Buffer | string | { hash: string },
  creds: Creds,
  region: string,
  now = new Date(),
): Record<string, string> {
  const u = new URL(url);
  const date = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = typeof payload === "object" && !Buffer.isBuffer(payload) ? payload.hash : sha256hex(payload);
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  h.host = u.host;
  h["x-amz-date"] = date;
  h["x-amz-content-sha256"] = payloadHash;
  if (creds.sessionToken) h["x-amz-security-token"] = creds.sessionToken;
  const names = Object.keys(h).sort();
  const canonHeaders = names.map((n) => `${n}:${String(h[n]).trim().replace(/\s+/g, " ")}\n`).join("");
  const q = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canon = [method, u.pathname, q, canonHeaders, names.join(";"), payloadHash].join("\n");
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", date, scope, sha256hex(canon)].join("\n");
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, date.slice(0, 8));
  const key = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(sts).digest("hex");
  delete h.host;
  h.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  return h;
}

/** A SigV4-signed raw S3 request. */
export function s3raw(
  endpoint: string,
  path: string,
  o: { method?: string; headers?: Record<string, string>; body?: Buffer | string; creds: Creds; region: string; keep?: number },
): Promise<RawResp> {
  const url = `${endpoint}${path}`;
  const method = o.method ?? "GET";
  const body = o.body ?? "";
  const h = sigv4(method, url, o.headers ?? {}, body, o.creds, o.region);
  return raw(url, { method, headers: h, body: method === "GET" || method === "HEAD" ? undefined : body, keep: o.keep });
}

/** XML error code / message from an S3 error body. */
export function xmlCode(text: string): string {
  return /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? "";
}

/** The headers SS03 reports, lowercased, with absent ones as "-". */
export function pick(h: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) out[n] = h[n] ?? "-";
  return out;
}
