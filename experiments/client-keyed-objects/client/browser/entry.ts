/**
 * Browser build of the same client library (bundled with `bun build
 * --target=browser`). The page runs one scenario for CK11 and returns JSON:
 *
 *   1. sign in (Auth, CORS), wrap a DEK (key service, CORS)
 *   2. S3 multipart upload of 64 MiB generated in the page, one 8 MiB chunk
 *      per part (8 parts), so ETags matter: the upload records whether the
 *      part ETags came from the UploadPart response header or, when the header
 *      is not exposed to the page, from ListParts (the XML body is readable)
 *   3. ranged decrypting reads through a Storage signed URL, S3 GetObject and
 *      /object/authenticated, compared with the page's own plaintext
 *   4. which response headers the page can read on a ranged signed-URL GET
 *
 * Only the Platform adapter differs from the Bun build.
 */
import { Ck, type Credentials, type Directory, type Platform } from "../src/ctx";
import { isCk } from "../src/errors";
import { readRange, type ReadPath } from "../src/read";
import { upload } from "../src/upload";

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

const browserPlatform: Platform = {
  // Buffers in memory and hashes at the end: fine for the 64 MiB the page handles.
  sha256Stream() {
    const parts: Uint8Array[] = [];
    return {
      update: (u) => void parts.push(u.slice()),
      digestHex: async () => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob(parts as BlobPart[]).arrayBuffer()))),
    };
  },
};

interface Cfg {
  directory: Directory;
  creds: Record<string, Credentials>;
  tenant: string;
  record: string;
  sizeMiB: number;
}

const err = (e: unknown) => (isCk(e) ? `${e.code}: ${e.message.slice(0, 160)}` : `${(e as Error)?.name ?? "Error"}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);

async function run(cfg: Cfg): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { origin: location.origin };
  const ck = new Ck(cfg.directory, cfg.creds, browserPlatform);
  const size = cfg.sizeMiB * 1024 * 1024;
  const plain = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(plain.subarray(o, o + 65536));
  const t = ck.target(cfg.tenant);
  try {
    await ck.session(t);
    out.signin = "ok";
  } catch (e) {
    out.signin = err(e);
    return out;
  }
  let assetId = "";
  try {
    const r = await upload(ck, { tenantId: cfg.tenant, recordId: cfg.record, source: new Blob([plain]), method: "s3-multipart", partChunks: 1 });
    assetId = r.assetId;
    out.upload = "ok";
    out.upload_parts = r.parts;
    out.upload_etag_source = r.etagSource;
    out.upload_ms = r.ms;
    out.upload_chunk_rows = r.chunkRows;
  } catch (e) {
    out.upload = err(e);
    return out;
  }
  const ranges: [number, number][] = [
    [0, 1024],
    [size / 2 - 3000, size / 2 + 3000],
    [size - 70_000, size],
  ];
  for (const path of ["signed-url", "s3", "authenticated"] as ReadPath[]) {
    let ok = 0;
    const errs: string[] = [];
    for (const [s, e] of ranges) {
      try {
        const r = await readRange(ck, cfg.tenant, assetId, s, e, { path });
        const want = plain.subarray(s, e);
        if (r.plain.length === want.length && r.plain.every((b, i) => b === want[i])) ok++;
        else errs.push("bytes differ");
      } catch (x) {
        errs.push(err(x));
      }
    }
    out[`read.${path}`] = errs.length ? `${ok}/${ranges.length} ok; ${errs[0]}` : `${ok}/${ranges.length} ok`;
  }
  // Header visibility on a ranged signed-URL GET.
  try {
    const s = await ck.session(t);
    const a = await fetch(`${t.url}/rest/v1/assets?id=eq.${assetId}&select=object_key`, {
      headers: { apikey: t.anonKey, authorization: `Bearer ${await s.token()}`, "accept-profile": "app" },
    }).then((r) => r.json());
    const key = (a as { object_key: string }[])[0]!.object_key;
    const sign = await fetch(`${t.url}/storage/v1/object/sign/${t.bucket}/${key}`, {
      method: "POST",
      headers: { apikey: t.anonKey, authorization: `Bearer ${await s.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ expiresIn: 60 }),
    }).then((r) => r.json() as Promise<{ signedURL: string }>);
    const r = await fetch(`${t.url}/storage/v1${sign.signedURL}`, { headers: { range: "bytes=0-99" } });
    await r.arrayBuffer();
    out.signed_get_status = r.status;
    out.signed_get_readable_headers = ["content-range", "etag", "content-length", "content-type", "cf-cache-status"].filter((h) => r.headers.get(h) !== null).join(",") || "none";
  } catch (e) {
    out.signed_get_readable_headers = err(e);
  }
  return out;
}

(window as unknown as { ckRun: typeof run }).ckRun = run;
