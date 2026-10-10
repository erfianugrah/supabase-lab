/**
 * Special-character key matrix against the Storage S3 endpoint, on the real
 * AWS SDK v3, then the same keys through the REST API (raw fetch with
 * RFC 3986 segment encoding, and supabase-js). Reads one JSON document on
 * stdin, writes one on stdout:
 *
 *   in:  { cfg: S3 config, bucket, restBase, restKey }
 *   out: { rows: [{ id, key, ops: { <op>: { ok, status, code, message } } }], latency: {...} }
 *
 * Ops per key (each independent; a failure is recorded, never retried):
 *   s3_put s3_head s3_get s3_list s3_presign s3_copy_from s3_multipart
 *   rest_get_s3_object   REST GET of the object the S3 PUT created
 *   rest_put_s3_get      REST POST of `rest/<key>`, then S3 GET of the same key
 *   sbjs_put_s3_get      supabase-js upload of `sbjs/<key>`, then S3 GET
 *   sbjs_get_s3_object   supabase-js download of the object the S3 PUT created
 *   s3_delete s3_head_after_delete
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { client, run, type Cfg, type OpResult } from "./s3op.ts";

const input = JSON.parse(readFileSync(0, "utf8")) as { cfg: Cfg; bucket: string; restBase: string; restKey: string };
const { cfg, bucket, restBase, restKey } = input;
const c = client(cfg);

const nfd = "cafe\u0301.txt";
const KEYS: Array<[string, string]> = [
  ["plain", "plain.txt"],
  ["space", "a b.txt"],
  ["plus", "a+b.txt"],
  ["percent", "100%.txt"],
  ["percent-20-literal", "a%20b.txt"],
  ["percent-2B-literal", "a%2Bb.txt"],
  ["equals", "a=b.txt"],
  ["ampersand", "a&b.txt"],
  ["comma", "a,b.txt"],
  ["semicolon", "a;b.txt"],
  ["at", `a${"@"}b.txt`], // built, so the source holds no email-shaped literal
  ["colon", "a:b.txt"],
  ["dollar", "a$b.txt"],
  ["bang", "a!b.txt"],
  ["apostrophe", "a'b.txt"],
  ["parens", "(a).txt"],
  ["asterisk", "a*b.txt"],
  ["tilde", "a~b.txt"],
  ["brackets", "a[1].txt"],
  ["braces", "a{1}.txt"],
  ["hash", "a#b.txt"],
  ["question", "a?b.txt"],
  ["caret-pipe", "a^b|c.txt"],
  ["backtick", "a`b.txt"],
  ["lt-gt", "a<b>.txt"],
  ["dquote", 'a"b.txt'],
  ["backslash", "a\\b.txt"],
  ["unicode-nfc", "caf\u00e9.txt"],
  ["unicode-nfd", nfd],
  ["unicode-cjk", "\u65e5\u672c\u8a9e.txt"],
  ["emoji", "\u{1f600}.txt"],
  ["nested-space", "dir one/sub dir/file name.txt"],
  ["nested-mixed", "a+b/c d/e=f/100%/g.txt"],
  ["double-slash", "a//b.txt"],
  ["leading-space", " lead.txt"],
  ["trailing-space", "trail .txt"],
  ["tab", "a\tb.txt"],
  ["dot-segment", "dot/./seg.txt"],
  ["dotdot-segment", "dot/../seg2.txt"],
  ["long-multibyte", `${"\u00e9a b+".repeat(40)}.txt`],
];

type Cell = { ok: boolean; status: number; code: string; message: string; ms?: number };
const cell = (r: OpResult): Cell => ({ ok: r.ok, status: r.status, code: r.code, message: r.message, ms: Math.round(r.ms * 10) / 10 });
const restEnc = (k: string) => k.split("/").map(encodeURIComponent).join("/");
const restH = { apikey: restKey, Authorization: `Bearer ${restKey}` };
const sb = createClient(restBase, restKey, { auth: { persistSession: false } });

async function restFetch(method: string, path: string, body?: string): Promise<Cell> {
  try {
    const r = await fetch(`${restBase}/storage/v1${path}`, { method, headers: { ...restH, ...(body !== undefined ? { "Content-Type": "text/plain" } : {}) }, body });
    const t = await r.text();
    return { ok: r.status === 200, status: r.status, code: "", message: t.slice(0, 120), ...(r.status === 200 ? { message: t.slice(0, 80) } : {}) };
  } catch (e) {
    return { ok: false, status: 0, code: "fetch", message: String((e as Error).message).slice(0, 120) };
  }
}

const rows: Array<{ id: string; key: string; ops: Record<string, Cell> }> = [];
for (const [id, key] of KEYS) {
  const body = `body-${id}-${crypto.randomUUID()}`;
  const ops: Record<string, Cell> = {};
  const withBody = (r: OpResult, want: string): Cell => {
    const x = cell(r);
    if (r.ok && r.body !== undefined && r.body !== want) return { ...x, ok: false, code: "BodyMismatch", message: `got ${r.body.slice(0, 60)}` };
    return x;
  };
  ops.s3_put = cell(await run(c, cfg, { op: "put", bucket, key, body }));
  ops.s3_head = cell(await run(c, cfg, { op: "head", bucket, key }));
  ops.s3_get = withBody(await run(c, cfg, { op: "get", bucket, key }), body);
  const l = await run(c, cfg, { op: "list", bucket, prefix: key });
  ops.s3_list = { ...cell(l), ...(l.ok && !(l.keys ?? []).includes(key) ? { ok: false, code: "KeyNotInListing", message: `listing returned ${JSON.stringify((l.keys ?? []).slice(0, 3))}` } : {}) };
  ops.s3_presign = withBody(await run(c, cfg, { op: "presign-get", bucket, key }), body);
  ops.s3_copy_from = cell(await run(c, cfg, { op: "copy", bucket, key: `copied/${id}.txt`, from: key }));
  ops.s3_multipart = cell(await run(c, cfg, { op: "multipart", bucket, key: `mp/${key}`, body }));
  ops.rest_get_s3_object = await (async () => {
    const r = await fetch(`${restBase}/storage/v1/object/authenticated/${bucket}/${restEnc(key)}`, { headers: restH }).catch(() => null);
    if (!r) return { ok: false, status: 0, code: "fetch", message: "" };
    const t = await r.text();
    return { ok: r.status === 200 && t === body, status: r.status, code: r.status === 200 && t !== body ? "BodyMismatch" : "", message: r.status === 200 ? "" : t.slice(0, 120) };
  })();
  const rkey = `rest/${key}`;
  const restBody = `rest-${id}-${crypto.randomUUID()}`;
  const rp = await fetch(`${restBase}/storage/v1/object/${bucket}/${restEnc(rkey)}`, { method: "POST", headers: { ...restH, "Content-Type": "text/plain" }, body: restBody }).catch(() => null);
  const rpText = rp ? await rp.text() : "";
  const sg = await run(c, cfg, { op: "get", bucket, key: rkey });
  ops.rest_put_s3_get = rp?.status === 200 ? withBody(sg, restBody) : { ok: false, status: rp?.status ?? 0, code: "RestPutFailed", message: rpText.slice(0, 120) };
  const skey = `sbjs/${key}`;
  const sbBody = `sbjs-${id}-${crypto.randomUUID()}`;
  const up = await sb.storage.from(bucket).upload(skey, sbBody, { contentType: "text/plain", upsert: true });
  const sg2 = await run(c, cfg, { op: "get", bucket, key: skey });
  ops.sbjs_put_s3_get = up.error ? { ok: false, status: 0, code: "SbjsPutFailed", message: String(up.error.message).slice(0, 120) } : withBody(sg2, sbBody);
  const dl = await sb.storage.from(bucket).download(key);
  if (dl.error) ops.sbjs_get_s3_object = { ok: false, status: 0, code: "SbjsGetFailed", message: String(dl.error.message).slice(0, 120) };
  else {
    const t = await dl.data.text();
    ops.sbjs_get_s3_object = { ok: t === body, status: 200, code: t === body ? "" : "BodyMismatch", message: "" };
  }
  ops.s3_delete = cell(await run(c, cfg, { op: "delete", bucket, key }));
  const h2 = await run(c, cfg, { op: "head", bucket, key });
  ops.s3_head_after_delete = { ok: !h2.ok && h2.status === 404, status: h2.status, code: h2.code, message: h2.message };
  rows.push({ id, key, ops });
}

// Latency baseline on one plain key (same client, sequential).
const lat: Record<string, number[]> = { put: [], get: [], head: [] };
for (let i = 0; i < 20; i++) {
  lat.put!.push((await run(c, cfg, { op: "put", bucket, key: "lat.txt", body: "x".repeat(64) })).ms);
  lat.get!.push((await run(c, cfg, { op: "get", bucket, key: "lat.txt" })).ms);
  lat.head!.push((await run(c, cfg, { op: "head", bucket, key: "lat.txt" })).ms);
}
console.log(JSON.stringify({ rows, latency: lat }));
