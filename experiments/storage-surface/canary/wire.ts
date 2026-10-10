/**
 * Control for the path-related SignatureDoesNotMatch results, nothing leaves
 * the machine. A local raw TCP listener receives the SDK's request, records
 * the request line, and re-computes the SigV4 signature (the test secret is a
 * dummy) over two candidate canonical paths:
 *
 *   wire  the path actually sent on the request line
 *   raw   the key split on "/" and percent-encoded per segment, i.e. what a
 *         server that never merges slashes or resolves dot segments signs
 *
 * `signed` reports which candidate reproduces the Authorization signature.
 * If it is `raw` while the wire path differs, the client changed the path
 * after signing and any S3-compatible server will answer
 * SignatureDoesNotMatch. If it is `wire` and wire equals raw, a mismatch at
 * the real endpoint is the endpoint's doing.
 *
 *   bun canary/wire.ts   or   node canary/wire.ts   -> JSON
 */
import net from "node:net";
import { createHash, createHmac } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const SECRET = "dummy-secret";
const REGION = "ap-southeast-1";
const keys = ["a//b.txt", "dot/./seg.txt", "dot/../seg2.txt", "a b.txt", "a+b.txt"];
const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

function signature(method: string, path: string, query: string, headers: Record<string, string>, signed: string[], date: string, payloadHash: string): string {
  const canonHeaders = signed.map((h) => `${h}:${(headers[h] ?? "").trim()}\n`).join("");
  const canon = [method, path, query, canonHeaders, signed.join(";"), payloadHash].join("\n");
  const scope = `${date.slice(0, 8)}/${REGION}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", date, scope, hex(canon)].join("\n");
  const kDate = hmac(`AWS4${SECRET}`, date.slice(0, 8));
  const key = hmac(hmac(hmac(kDate, REGION), "s3"), "aws4_request");
  return createHmac("sha256", key).update(sts).digest("hex");
}

const captured: Array<{ line: string; headers: Record<string, string> }> = [];
const srv = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const [line, ...hs] = buf.slice(0, end).split("\r\n");
    const headers: Record<string, string> = {};
    for (const h of hs) {
      const i = h.indexOf(":");
      headers[h.slice(0, i).toLowerCase()] = h.slice(i + 1).trim();
    }
    captured.push({ line: line!, headers });
    sock.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    buf = "";
  });
  sock.on("error", () => {});
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as net.AddressInfo).port;
const c = new S3Client({
  forcePathStyle: true,
  region: REGION,
  endpoint: `http://127.0.0.1:${port}/storage/v1/s3`,
  credentials: { accessKeyId: "x", secretAccessKey: SECRET },
  maxAttempts: 1,
});
const out: Array<{ key: string; requestLine: string; signed: string }> = [];
for (const key of keys) {
  captured.length = 0;
  await c.send(new PutObjectCommand({ Bucket: "b", Key: key, Body: "x" })).catch(() => null);
  const cap = captured[0];
  if (!cap) {
    out.push({ key, requestLine: "(none)", signed: "n/a" });
    continue;
  }
  const [method, target] = cap.line.split(" ") as [string, string];
  const [wirePath, query = ""] = target.split("?");
  const auth = cap.headers.authorization ?? "";
  const sigWanted = /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? "";
  const signedHeaders = (/SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? "").split(";");
  const date = cap.headers["x-amz-date"] ?? "";
  const payload = cap.headers["x-amz-content-sha256"] ?? "";
  const rawPath = `/storage/v1/s3/b/${key.split("/").map(encodeURIComponent).join("/")}`;
  const sigWire = signature(method, wirePath!, query, cap.headers, signedHeaders, date, payload);
  const sigRaw = signature(method, rawPath, query, cap.headers, signedHeaders, date, payload);
  const signed = sigWire === sigWanted && sigRaw === sigWanted ? "wire=raw" : sigWire === sigWanted ? "wire" : sigRaw === sigWanted ? "raw" : "neither";
  out.push({ key, requestLine: cap.line.replace(/\?x-id=\w+/, "").replace(" HTTP/1.1", ""), signed: `${signed} (wire path ${wirePath === rawPath ? "equals" : "differs from"} raw path)` });
}
srv.close();
console.log(JSON.stringify(out, null, 1));
