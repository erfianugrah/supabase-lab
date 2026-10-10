/**
 * SS02 - S3-protocol canary for special-character object keys.
 *
 * Question: does the Storage S3 endpoint accept (SigV4 verify, round-trip)
 * object keys containing space, +, %, =, unicode and other reserved
 * characters when the client is the AWS SDK for JavaScript v3, and do the
 * same keys behave the same through the REST API?
 *
 * Auth form: the session-token form of S3 authentication (access key id =
 * project ref, secret access key = anon key, session token = a JWT; here the
 * service_role JWT). Dashboard-generated S3 access keys have no API, so they
 * are NOT exercised: the signing code is the same SigV4 either way, but that
 * is reasoned, not measured. Docs:
 * https://supabase.com/docs/guides/storage/s3/authentication
 *
 * One matrix = 40 keys x { PUT, HEAD, GET, ListObjectsV2 with Prefix=key,
 * presigned GET, CopyObject with the key as source, one-part multipart,
 * DELETE then HEAD } plus four REST legs (see canary/matrix.ts). Run four
 * times: {storage host, gateway host} x {Bun, Node} as the JavaScript
 * runtime under the SDK, so a client-runtime artifact can be told from an
 * endpoint behaviour.
 *
 *   SS02a  <ref>.storage.supabase.co, SDK on Bun
 *   SS02b  <ref>.supabase.co,         SDK on Bun
 *   SS02c  <ref>.storage.supabase.co, SDK on Node
 *   SS02d  <ref>.supabase.co,         SDK on Node
 *   SS02e  REST and supabase-js legs on the same keys (from the SS02a run)
 *   SS02f  stored names: the `rest/<key>` rows in storage.objects equal the
 *          requested key byte for byte
 *   SS02g  per-request latency of PUT/GET/HEAD on a 64-byte object, 20
 *          each, per run. A baseline for a canary, not a claim about an
 *          incident.
 *   SS02h  wire control: the request line the SDK sends for keys with `//`
 *          and dot segments on each runtime, captured by a local listener,
 *          and which path (sent or unresolved) its SigV4 signature covers
 *
 * The SDK runs in a child process (canary/), see canary/s3op.ts.
 * Deletes its project in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type Proj, authHeaders, median, mgmtSql, missingTools, pct, provision, r1, s3cfg, s3matrix, s3wire, teardown } from "../lib";

type Cell = { ok: boolean; status: number; code: string; message: string; ms?: number };
type Row = { id: string; key: string; ops: Record<string, Cell> };
type Matrix = { rows: Row[]; latency: Record<string, number[]> };

const S3_OPS = ["s3_put", "s3_head", "s3_get", "s3_list", "s3_presign", "s3_copy_from", "s3_multipart", "s3_delete", "s3_head_after_delete"];
const REST_OPS = ["rest_get_s3_object", "rest_put_s3_get", "sbjs_put_s3_get", "sbjs_get_s3_object"];

/** Source-safe rendering of a key: ASCII only, truncated. */
const show = (k: string) =>
  JSON.stringify(k)
    .slice(1, -1)
    .replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .slice(0, 48);

function summarise(m: Matrix, ops: string[], prefix: string) {
  const meas: Record<string, number | string> = { keys: m.rows.length };
  const lines: string[] = [];
  let sigKeys = 0;
  let invalidKeys = 0;
  let acceptedKeys = 0;
  let acceptedAllOk = 0;
  const sigIds: string[] = [];
  const otherFailIds: string[] = [];
  for (const op of ops) {
    const cells = m.rows.map((r) => r.ops[op]).filter((x): x is Cell => !!x);
    meas[`${prefix}${op}_ok`] = `${cells.filter((x) => x.ok).length}/${cells.length}`;
  }
  for (const r of m.rows) {
    const failed = ops.filter((op) => r.ops[op] && !r.ops[op]!.ok);
    const putOk = r.ops.s3_put?.ok ?? false;
    if (putOk) {
      acceptedKeys++;
      if (!failed.some((op) => op.startsWith("s3_"))) acceptedAllOk++;
    }
    if (r.ops.s3_put?.code === "InvalidKey") invalidKeys++;
    const sig = failed.some((op) => r.ops[op]!.code === "SignatureDoesNotMatch");
    if (sig) {
      sigKeys++;
      sigIds.push(r.id);
    } else if (failed.length && r.ops.s3_put?.code !== "InvalidKey") otherFailIds.push(r.id);
    if (failed.length) {
      const f = r.ops[failed[0]!]!;
      lines.push(`[${r.id}] ${show(r.key)}: ${failed.length} failing ops; first ${failed[0]} -> ${f.status} ${f.code || "-"} ${f.message.replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }
  meas[`${prefix}keys_put_accepted`] = acceptedKeys;
  meas[`${prefix}keys_put_invalid_key_400`] = invalidKeys;
  meas[`${prefix}keys_all_s3_ops_ok_of_accepted`] = `${acceptedAllOk}/${acceptedKeys}`;
  meas[`${prefix}keys_with_signature_does_not_match`] = sigKeys;
  meas[`${prefix}signature_mismatch_key_ids`] = sigIds.join(",") || "none";
  meas[`${prefix}other_failing_key_ids`] = otherFailIds.join(",") || "none";
  return { meas, lines, sigKeys };
}

const mod: TestModule = {
  id: "SS02",
  title: "S3 endpoint special-character key canary (aws-sdk v3) vs REST",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SS02", title: "SS02", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = missingTools(["bun", "node"]);
    if (missing.length) return [{ id: "SS02", title: "SS02", status: "skip", detail: `required tool not on PATH: ${missing.join(", ")}` }];
    const out: TestResult[] = [];
    const ids = ["SS02a", "SS02b", "SS02c", "SS02d", "SS02e", "SS02f", "SS02g", "SS02h"];
    let ref = "";
    try {
      let proj: Proj;
      try {
        proj = await provision(ctx, org, "ss02");
      } catch (e) {
        ref = (e as { ref?: string }).ref ?? "";
        throw e;
      }
      ref = proj.ref;
      const mk = async (id: string) => {
        const r = await fetch(`${proj.apiBase}/storage/v1/bucket`, {
          method: "POST",
          headers: authHeaders(proj.service, { "Content-Type": "application/json" }),
          body: JSON.stringify({ id, name: id, public: false }),
        });
        if (r.status !== 200) throw new Error(`create bucket ${id}: ${r.status} ${await r.text()}`);
      };
      const combos: Array<[string, "storage" | "api", "bun" | "node", string]> = [
        ["SS02a", "storage", "bun", "<ref>.storage.supabase.co, SDK on Bun"],
        ["SS02b", "api", "bun", "<ref>.supabase.co, SDK on Bun"],
        ["SS02c", "storage", "node", "<ref>.storage.supabase.co, SDK on Node"],
        ["SS02d", "api", "node", "<ref>.supabase.co, SDK on Node"],
      ];
      const matrices = new Map<string, Matrix>();
      for (const [id, host, runtime, label] of combos) {
        const bucket = `canary-${host}-${runtime}`;
        await mk(bucket);
        const m = (await s3matrix(s3cfg(proj, host), bucket, proj.apiBase, proj.service, runtime)) as Matrix;
        matrices.set(id, m);
        const s = summarise(m, S3_OPS, "");
        out.push({
          id,
          title: `${id}: S3 matrix, ${label}`,
          status: s.sigKeys === 0 ? "pass" : "fail",
          detail: s.sigKeys === 0 ? "pass = no SignatureDoesNotMatch" : `${s.sigKeys} keys got SignatureDoesNotMatch`,
          measurements: s.meas,
          evidence: s.lines.join("\n") || "no failing key",
        });
      }

      const a = matrices.get("SS02a")!;
      const c = matrices.get("SS02c")!;
      const r1s = summarise(a, REST_OPS, "bun_run_");
      const r2s = summarise(c, REST_OPS, "node_run_");
      out.push({
        id: "SS02e",
        title: "SS02e: same keys through REST and supabase-js",
        status: "info",
        detail: "REST legs use the same Storage key validation; failures here are listed, not graded",
        measurements: { ...r1s.meas, ...r2s.meas },
        evidence: [...r1s.lines.map((x) => `bun-run ${x}`), ...r2s.lines.map((x) => `node-run ${x}`)].join("\n") || "no failing key",
      });

      // SS02f: the rows the REST POST created carry the exact key
      const want = new Map<string, string>();
      for (const r of a.rows) if (r.ops.rest_put_s3_get?.ok) want.set(`rest/${r.key}`, r.id);
      const db = await mgmtSql(ctx, ref, "select name from storage.objects where bucket_id = 'canary-storage-bun' and name like 'rest/%'");
      const have = new Set(db.rows.map((x) => String(x.name)));
      const missing = [...want.keys()].filter((k) => !have.has(k));
      out.push({
        id: "SS02f",
        title: "SS02f: stored names equal requested keys",
        status: db.status < 300 && missing.length === 0 ? "pass" : "fail",
        measurements: { expected: want.size, found_exact: want.size - missing.length, db_rows: have.size },
        evidence: missing.map((k) => `missing exact name: ${want.get(k)} ${show(k)}`).join("\n") || undefined,
      });

      const lat: Record<string, number | string> = { samples_per_op: 20 };
      for (const [id, , , label] of combos) {
        const m = matrices.get(id)!;
        const tag = id.toLowerCase();
        for (const op of ["put", "get", "head"]) {
          const xs = m.latency[op] ?? [];
          lat[`${tag}_${op}_median_ms`] = r1(median(xs));
          lat[`${tag}_${op}_p95_ms`] = r1(pct(xs, 95));
        }
        lat[`${tag}_is`] = label;
      }
      out.push({ id: "SS02g", title: "SS02g: S3 request latency baseline", status: "info", detail: "no pass band; laptop client to ap-southeast-1", measurements: lat });

      const wm: Record<string, number | string> = {};
      for (const runtime of ["bun", "node"] as const) {
        const wire = (await s3wire(runtime)) as Array<{ key: string; requestLine: string; signed: string }>;
        for (const w of wire) wm[`${runtime}_${show(w.key).replace(/[^a-z0-9]/gi, "_")}`] = `${w.requestLine} | signature covers: ${w.signed}`;
      }
      out.push({ id: "SS02h", title: "SS02h: request line the SDK sends and the path its signature covers (local listener, no network)", status: "info", measurements: wm });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) if (!out.some((r) => r.id === id)) out.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      if (ref) {
        const s = await teardown(ctx, ref).catch(() => -1);
        ctx.log(`SS02 teardown DELETE -> ${s}`);
      }
    }
    for (const id of ids) if (!out.some((r) => r.id === id)) out.push({ id, title: id, status: "skip", detail: "row never produced" });
    return out;
  },
};
export default mod;
