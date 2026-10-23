/**
 * SS11 - the gaps SS03 to SS09 left on managed Storage: how long an
 * overwritten object stays stale on the paths SS09b did not poll, whether a
 * fresh signed URL or a CDN purge changes it; objects past 2 GiB through S3
 * multipart and through TUS; parallel UploadPart throughput; two clients on
 * one TUS upload URL.
 *
 * SS03e saw `/object/authenticated` serve pre-overwrite bytes for a ranged
 * read after an S3 overwrite and did not time it. SS09b timed REST upserts on
 * the public URL and a reused signed URL (v1 served for up to 46 s, every
 * read v2 from 51 s, n = 3 runs). SS11a times the rest, with a public-URL
 * control in the same window.
 *
 * One throwaway Pro-org project `ss-ss11-<epoch>` in ap-southeast-1, deleted
 * in `finally`. Buckets `pub` (public) and `priv` (private), a select policy
 * for any authenticated user on both; one signed-in user (U) reads the
 * authenticated and download paths. Uploads, overwrites, signing and purge use
 * the service key.
 *
 *   SS11_setup  storage version, buckets, policy, user, upload limit raised
 *   SS11a       14 trials in parallel, two per arm: warmed until HIT (at most
 *               12 reads, 1.5 s apart), overwritten (v1 1,000 B of `a`, v2
 *               2,000 B of `b`), then read every 5 s for 150 s:
 *                 public_control       public URL, REST upsert (SS09b's case)
 *                 public_purge         same, then DELETE /cdn/pub/<key>
 *                 auth_range           /object/authenticated, Range 0-99, S3
 *                                      PutObject overwrite (SS03e's case)
 *                 auth_range_purge     same, then purge
 *                 auth_other_range     warmed with Range 0-99, polled with
 *                                      Range 100-199 after the S3 overwrite
 *                 download_priv        GET /object/priv/<key> as U (the
 *                                      supabase-js download() request), REST upsert
 *                 fresh_signed         priv, a reused signed URL warmed, REST
 *                                      upsert, then a NEW signed URL per read
 *   SS11e       two clients on one TUS upload URL (12 MiB upload): both PATCH
 *               offset 0 while the first is still sending (`overlap`); HEAD
 *               then PATCH while the first is sending (`head-during`); two
 *               tus-js-client processes resuming one URL with the same 64 MiB
 *   SS11b       UploadPart concurrency 1, 8, 4, 16 on 256 MiB (16 x 16 MiB),
 *               direct host, one upload each: wall time, MB/s, per-part times
 *   SS11c       2304 MiB (144 x 16 MiB) multipart at concurrency 8, direct
 *               host; SHA-256 of a full GET from the gateway; HEAD/list/metadata size
 *   SS11d       the same 2304 MiB through TUS (tus-js-client, 6 MiB chunks),
 *               direct host; SHA-256 of a full GET; metadata size
 *
 * Every row is `info` except the integrity checks (hash equality, ETag form
 * for the sub-runs). Single samples from one laptop vantage: SS11b/c/d times
 * are not a platform throughput figure.
 *
 * DESTRUCTIVE: one project, deleted in finally. Cost: about 25 minutes of
 * Micro compute, about 5.8 GiB up and 4.5 GiB down (two full GETs of 2304 MiB).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { canary, managedTarget, mgmtRetry, mgmtSql, provision, s3cfg, s3ops, sleep, storageConfig, teardown, tusChild, type Proj, type Target } from "../lib";

const FIX_DIR = new URL("../evidence/fixtures/", import.meta.url).pathname;
const MiB = 1024 * 1024;
const RAISED_LIMIT = 10 * 1024 * 1024 * 1024;

interface Read {
  status: number;
  cf: string;
  bytes: number;
  first: string;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Read> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, cf: r.headers.get("cf-cache-status") ?? "", bytes: b.length, first: b.length ? String.fromCharCode(b[0]!) : "" };
  } catch (e) {
    return { status: 0, cf: `err ${(e as Error).name}`, bytes: 0, first: "" };
  }
}

/** v1 / v2 / other, from the fill letter (`a` v1, `b` v2) of a whole or ranged read. */
const ver = (r: Read) => (r.status >= 200 && r.status < 300 ? (r.first === "a" ? "v1" : r.first === "b" ? "v2" : "other") : `s${r.status}`);

const mod: TestModule = {
  id: "SS11",
  title: "Overwrite staleness per path, CDN purge, objects past 2 GiB (S3 multipart, TUS), parallel parts, two TUS clients on one URL",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SS11", title: "SS11", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if (!Bun.which("node")) return [{ id: "SS11", title: "SS11", status: "skip", detail: "node not on PATH (the canary runs under Node)" }];
    const only = (ctx.endpoints["ss11_rows"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const want = (id: string) => !only.length || only.includes(id);
    const out: TestResult[] = [];
    let p: Proj | undefined;
    let ref = "";
    try {
      try {
        p = await provision(ctx, org, "ss11");
        ref = p.ref;
      } catch (e) {
        ref = (e as { ref?: string }).ref ?? "";
        throw e;
      }
      const t: Target = managedTarget(p);
      const rest = `${p.apiBase}/storage/v1`;
      const svc = { apikey: p.service, Authorization: `Bearer ${p.service}` };
      const setup: Record<string, string | number> = {};
      setup.storage_version = ((await fetch(`${rest}/version`).then((r) => r.text()).catch(() => "")).slice(0, 40)) || "unknown";
      for (const [id, pub] of [["pub", true], ["priv", false]] as const) {
        const r = await fetch(`${rest}/bucket`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ id, name: id, public: pub }) });
        setup[`bucket_${id}`] = r.status;
      }
      setup.policy = (await mgmtSql(ctx, ref, `create policy ss11_read on storage.objects for select to authenticated using (bucket_id in ('pub','priv'))`)).status;
      const email = `ss11-${Date.now()}@example.com`;
      const password = `${crypto.randomUUID()}Aa1!`;
      const cu = await fetch(`${p.apiBase}/auth/v1/admin/users`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
      setup.user_create = cu.status;
      const si = await fetch(`${p.apiBase}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: p.anon, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const jwt = ((await si.json().catch(() => ({}))) as { access_token?: string }).access_token ?? "";
      setup.user_sign_in = si.status;
      if (!jwt) throw new Error(`sign-in: HTTP ${si.status}`);
      t.secrets.push(jwt);
      const user = { apikey: p.anon, Authorization: `Bearer ${jwt}` };

      let n = 0;
      const newKey = () => `ss11/${Date.now()}-${n++}.bin`;
      const restPut = async (bucket: string, key: string, size: number, fill: string) => {
        const r = await fetch(`${rest}/object/${bucket}/${key}`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/octet-stream", "cache-control": "max-age=3600", "x-upsert": "true" },
          body: fill.repeat(size),
        });
        await r.text();
        return r.status;
      };
      const s3Put = async (bucket: string, key: string, size: number, fill: string) => {
        const [r] = await s3ops(s3cfg(p!, "storage"), [{ op: "put", bucket, key, body: fill.repeat(size) }]);
        return r?.ok ? 200 : r?.status ?? -1;
      };
      let signSeq = 0;
      const sign = async (bucket: string, key: string) => {
        // a distinct expiresIn per URL: URLs signed in the same second with the same expiresIn are identical (SS10 smoke 1)
        const r = await fetch(`${rest}/object/sign/${bucket}/${key}`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 + signSeq++ }) });
        const j = (await r.json().catch(() => ({}))) as { signedURL?: string };
        if (!j.signedURL) throw new Error(`sign ${bucket}/${key}: HTTP ${r.status}`);
        return `${rest}${j.signedURL}`;
      };
      const purge = async (bucket: string, key: string) => {
        const r = await fetch(`${rest}/cdn/${bucket}/${key}`, { method: "DELETE", headers: svc });
        return `${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 120)}`;
      };

      // ---- SS11a: staleness after overwrite, per path ----
      if (want("SS11a")) {
        const m: Record<string, string | number> = {};
        type Trial = { label: string; warm: () => Promise<Read>; poll: () => Promise<Read>; overwrite: () => Promise<number>; purge?: () => Promise<string> };
        const trials: Trial[] = [];
        for (let i = 1; i <= 2; i++) {
          {
            const k = newKey();
            await restPut("pub", k, 1000, "a");
            const u = `${rest}/object/public/pub/${k}`;
            trials.push({ label: `public_control_${i}`, warm: () => get(u), poll: () => get(u), overwrite: () => restPut("pub", k, 2000, "b") });
          }
          {
            const k = newKey();
            await restPut("pub", k, 1000, "a");
            const u = `${rest}/object/public/pub/${k}`;
            trials.push({ label: `public_purge_${i}`, warm: () => get(u), poll: () => get(u), overwrite: () => restPut("pub", k, 2000, "b"), purge: () => purge("pub", k) });
          }
          {
            const k = newKey();
            await restPut("pub", k, 1000, "a");
            const u = `${rest}/object/authenticated/pub/${k}`;
            const rd = () => get(u, { ...user, Range: "bytes=0-99" });
            trials.push({ label: `auth_range_${i}`, warm: rd, poll: rd, overwrite: () => s3Put("pub", k, 2000, "b") });
          }
          {
            const k = newKey();
            await restPut("pub", k, 1000, "a");
            const u = `${rest}/object/authenticated/pub/${k}`;
            const rd = () => get(u, { ...user, Range: "bytes=0-99" });
            trials.push({ label: `auth_range_purge_${i}`, warm: rd, poll: rd, overwrite: () => s3Put("pub", k, 2000, "b"), purge: () => purge("pub", k) });
          }
          {
            const k = newKey();
            await restPut("pub", k, 1000, "a");
            const u = `${rest}/object/authenticated/pub/${k}`;
            trials.push({ label: `auth_other_range_${i}`, warm: () => get(u, { ...user, Range: "bytes=0-99" }), poll: () => get(u, { ...user, Range: "bytes=100-199" }), overwrite: () => s3Put("pub", k, 2000, "b") });
          }
          {
            const k = newKey();
            await restPut("priv", k, 1000, "a");
            const u = `${rest}/object/priv/${k}`;
            trials.push({ label: `download_priv_${i}`, warm: () => get(u, user), poll: () => get(u, user), overwrite: () => restPut("priv", k, 2000, "b") });
          }
          {
            const k = newKey();
            await restPut("priv", k, 1000, "a");
            const reused = await sign("priv", k);
            trials.push({ label: `fresh_signed_${i}`, warm: () => get(reused), poll: async () => get(await sign("priv", k)), overwrite: () => restPut("priv", k, 2000, "b") });
          }
        }
        m.trials = trials.length;
        m.poll = "every 5 s for 150 s";
        await Promise.all(
          trials.map(async (tr) => {
            const warm: string[] = [];
            for (let i = 0; i < 12; i++) {
              const r = await tr.warm();
              warm.push(`${r.status}/${r.cf || "-"}/${ver(r)}`);
              if (r.cf === "HIT") break;
              await sleep(1500);
            }
            m[`${tr.label}_warm`] = warm.join(" ");
            m[`${tr.label}_overwrite_status`] = await tr.overwrite();
            const at = Date.now();
            if (tr.purge) {
              m[`${tr.label}_purge`] = await tr.purge();
              m[`${tr.label}_purge_done_s`] = Math.round((Date.now() - at) / 100) / 10;
            }
            const trace: string[] = [];
            let firstV2 = -1;
            let lastV1 = -1;
            while (Date.now() - at < 150_000) {
              const r = await tr.poll();
              const s = Math.round((Date.now() - at) / 1000);
              const v = ver(r);
              trace.push(`${s}s:${r.cf || "-"}/${v}`);
              if (v === "v2" && firstV2 < 0) firstV2 = s;
              if (v === "v1") lastV1 = s;
              await sleep(5000);
            }
            m[`${tr.label}_first_v2_s`] = firstV2;
            m[`${tr.label}_last_v1_s`] = lastV1;
            m[`${tr.label}_trace`] = trace.join(" ");
          }),
        );
        const sum = trials.map((tr) => `${tr.label}=${m[`${tr.label}_first_v2_s`]}/${m[`${tr.label}_last_v1_s`]}`).join(", ");
        out.push({ id: "SS11a", title: "seconds from the overwrite to the first v2 read / the last v1 read (-1 = none), per path; purge and fresh signed URL arms", status: "info", detail: sum, measurements: m });
      }

      // ---- fixtures and the raised upload limit (SS11b-e) ----
      const fx = await canary("ss11.ts", { cmd: "fixtures", dir: FIX_DIR });
      setup.fixtures = `huge=${fx.huge.size} r1=${fx.r1.size} r2=${fx.r2.size}`;
      const cfg = await storageConfig(ctx, ref);
      setup.default_file_size_limit = String((cfg.json as { fileSizeLimit?: number })?.fileSizeLimit ?? cfg.status);
      const pt = await mgmtRetry(ctx, "PATCH", `/projects/${ref}/config/storage`, { fileSizeLimit: RAISED_LIMIT });
      const after = await storageConfig(ctx, ref);
      setup.raise_limit = `PATCH ${pt.status}; fileSizeLimit now ${(after.json as { fileSizeLimit?: number })?.fileSizeLimit ?? after.status}`;
      let accepted = "";
      const l0 = Date.now();
      while (Date.now() - l0 < 5 * 60_000) {
        const r = await canary("upload.ts", { target: t, cmd: "put-file", host: "direct", bucket: "pub", key: "limit-probe.bin", path: fx.r1.path });
        if (r.ok) {
          accepted = `${Math.round((Date.now() - l0) / 1000)}s`;
          break;
        }
        await sleep(10_000);
      }
      setup.raised_limit_effective_after = accepted || "not within 300 s";
      out.push({ id: "SS11_setup", title: "project, buckets, policy, user, raised upload limit", status: "info", detail: `storage ${setup.storage_version}`, measurements: setup });
      if (!accepted) throw new Error("raised upload limit never took effect");
      const del = async (bucket: string, names: string[]) => {
        const r = await fetch(`${rest}/object/${bucket}`, { method: "DELETE", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ prefixes: names }) });
        await r.text();
        return r.status;
      };
      await del("pub", ["limit-probe.bin"]);

      // ---- SS11e: two clients on one TUS upload URL ----
      if (want("SS11e")) {
        const m: Record<string, string | number> = { upload_host: "direct" };
        for (const sc of ["overlap", "head-during"] as const) {
          const r = await canary("ss11.ts", { target: t, cmd: "tus-race", host: "direct", bucket: "pub", key: `race-${sc}.bin`, scenario: sc });
          if (!r.ok) m[`${sc}_create`] = String(r.create);
          for (const [k, v] of Object.entries(r.rows ?? {})) m[`${sc}_${k}`] = v as string | number;
        }
        // two tus-js-client processes resuming one URL with identical bytes (two tabs resuming the same upload)
        const c = await canary("ss11.ts", { target: t, cmd: "tus-create", host: "direct", bucket: "pub", key: "race-pair.bin", length: fx.r1.size });
        m.pair_create = c.status;
        if (c.url) {
          const tusHeaders = { authorization: `Bearer ${t.service}`, apikey: t.service, "x-upsert": "true" };
          const one = () => tusChild({ endpoint: `${t.hosts[1]!.rest}/upload/resumable`, uploadUrl: c.url, file: fx.r1.path, size: fx.r1.size, chunkSize: 6 * MiB, headers: tusHeaders, bucket: "pub", key: "race-pair.bin" }, 0, 600_000);
          const [x, y] = await Promise.all([one(), one()]);
          for (const [lbl, res] of [["pair_client1", x], ["pair_client2", y]] as const) {
            const fin = res.lines.find((l) => l.done);
            const statuses = res.lines.filter((l) => l.resp).map((l) => `${l.resp.method}:${l.resp.status}`);
            m[`${lbl}_outcome`] = fin ? (fin.ok ? `completed, ${fin.chunks} chunks` : `failed after ${fin.chunks} chunks: ${fin.status} ${String(fin.error ?? "").slice(0, 160)}`) : "no final line";
            m[`${lbl}_responses`] = statuses.join(" ").slice(0, 400);
          }
          const g = await canary("upload.ts", { target: t, cmd: "get-sha", host: "gateway", bucket: "pub", key: "race-pair.bin" });
          m.pair_get = g.ok ? `${g.status} bytes=${g.bytes} sha256_equals_fixture=${g.sha256 === fx.r1.sha256}` : `${g.status} ${g.code}`;
        }
        await del("pub", ["race-overlap.bin", "race-head-during.bin", "race-pair.bin"]);
        out.push({ id: "SS11e", title: "two clients on one TUS upload URL", status: "info", measurements: m });
      }

      // ---- SS11b: UploadPart concurrency on 256 MiB ----
      if (want("SS11b")) {
        const m: Record<string, string | number> = { parts: 16, part_mib: 16, upload_host: "direct", order: "1,8,4,16" };
        let allOk = true;
        for (const c of [1, 8, 4, 16]) {
          const r = await canary("ss11.ts", { target: t, cmd: "mpu-parallel", host: "direct", bucket: "pub", key: `par-c${c}.bin`, fx: fx.huge, parts: 16, concurrency: c });
          m[`c${c}`] = r.ok ? `${r.ms} ms, ${r.mbps} MB/s, part p50 ${r.partMsP50} p95 ${r.partMsP95} max ${r.partMsMax} ms, in flight max ${r.inflightMax}, complete ${r.completeStatus}, etag aws-form ${r.etagIsAws}` : `failed: ${String(r.failed ?? r.code ?? "").slice(0, 160)}`;
          m[`c${c}_mbps`] = r.mbps ?? -1;
          if (!r.ok || !r.etagIsAws) allOk = false;
          await del("pub", [`par-c${c}.bin`]);
        }
        out.push({ id: "SS11b", title: "multipart 256 MiB at UploadPart concurrency 1, 8, 4, 16 (one upload each, one vantage)", status: allOk ? "pass" : "fail", detail: [1, 8, 4, 16].map((c) => `c${c}=${m[`c${c}_mbps`]} MB/s`).join(", "), measurements: m });
      }

      const sizeRows = async (name: string, m: Record<string, string | number>) => {
        const q = await mgmtSql(ctx, ref, `select metadata->>'size' as size, metadata->>'contentLength' as cl from storage.objects where bucket_id = 'pub' and name = '${name}'`);
        const row = q.rows[0] ?? {};
        m.metadata_size = String(row.size ?? `none (${q.status})`);
        m.metadata_content_length = String(row.cl ?? "-");
        const ls = await fetch(`${rest}/object/list/pub`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 100 }) });
        const arr = ((await ls.json().catch(() => [])) as Array<{ name?: string; metadata?: { size?: number } }>) ?? [];
        m.rest_list_size = String(arr.find((x) => x.name === name)?.metadata?.size ?? `absent (${ls.status})`);
        const hd = await fetch(`${rest}/object/authenticated/pub/${name}`, { method: "HEAD", headers: svc });
        m.rest_head_content_length = hd.headers.get("content-length") ?? "-";
      };

      // ---- SS11c: 2304 MiB through S3 multipart, concurrency 8 ----
      if (want("SS11c")) {
        const m: Record<string, string | number> = { bytes: fx.huge.size, parts: 144, concurrency: 8, upload_host: "direct" };
        const r = await canary("ss11.ts", { target: t, cmd: "mpu-parallel", host: "direct", bucket: "pub", key: "huge-mpu.bin", fx: fx.huge, parts: 144, concurrency: 8 }, 3_600_000);
        m.upload = r.ok ? `${r.ms} ms, ${r.mbps} MB/s, part p50 ${r.partMsP50} p95 ${r.partMsP95} max ${r.partMsMax} ms, complete ${r.completeStatus}` : `failed: ${String(r.failed ?? r.code ?? "").slice(0, 200)}`;
        m.upload_ms = r.ms ?? -1;
        m.upload_mbps = r.mbps ?? -1;
        m.final_etag_aws_form = String(r.etagIsAws ?? "-");
        const g = await canary("upload.ts", { target: t, cmd: "get-sha", host: "gateway", bucket: "pub", key: "huge-mpu.bin" }, 3_600_000);
        m.get = g.ok ? `${g.status} bytes=${g.bytes} content-length=${g.contentLength} ms=${Math.round(g.ms)}` : `${g.status} ${g.code} ${g.msg ?? ""}`;
        m.get_sha256_equals_fixture = g.ok ? String(g.sha256 === fx.huge.sha256) : "no";
        await sizeRows("huge-mpu.bin", m);
        m.delete = await del("pub", ["huge-mpu.bin"]);
        out.push({ id: "SS11c", title: "2304 MiB multipart (144 x 16 MiB, concurrency 8): completes, full GET hash, recorded size", status: r.ok && g.ok && g.sha256 === fx.huge.sha256 ? "pass" : "fail", detail: `upload ${m.upload_mbps} MB/s; sha ${m.get_sha256_equals_fixture}; size ${m.metadata_size}`, measurements: m });
      }

      // ---- SS11d: 2304 MiB through TUS ----
      if (want("SS11d")) {
        const m: Record<string, string | number> = { bytes: fx.huge.size, chunk_mib: 6, upload_host: "direct" };
        const tusHeaders = { authorization: `Bearer ${t.service}`, apikey: t.service, "x-upsert": "true" };
        const t0 = Date.now();
        const k = await tusChild({ endpoint: `${t.hosts[1]!.rest}/upload/resumable`, file: fx.huge.path, size: fx.huge.size, chunkSize: 6 * MiB, headers: tusHeaders, bucket: "pub", key: "huge-tus.bin" }, 0, 3_600_000);
        const ms = Date.now() - t0;
        const fin = k.lines.find((l) => l.done);
        const created = k.lines.find((l) => l.resp?.method === "POST")?.resp;
        m.creation = `${created?.status ?? "-"} tus-max-size=${created?.headers?.["tus-max-size"] ?? "-"}`;
        m.outcome = fin ? (fin.ok ? `completed, ${fin.chunks} chunks` : `failed after ${fin.chunks} chunks: ${fin.status} ${String(fin.error ?? "").slice(0, 160)}`) : "no final line";
        m.upload_ms = ms;
        m.upload_mbps = Math.round((fx.huge.size / 1e6 / (ms / 1000)) * 10) / 10;
        const g = await canary("upload.ts", { target: t, cmd: "get-sha", host: "gateway", bucket: "pub", key: "huge-tus.bin" }, 3_600_000);
        m.get = g.ok ? `${g.status} bytes=${g.bytes} content-length=${g.contentLength} ms=${Math.round(g.ms)}` : `${g.status} ${g.code} ${g.msg ?? ""}`;
        m.get_sha256_equals_fixture = g.ok ? String(g.sha256 === fx.huge.sha256) : "no";
        m.etag_form = /^"?[0-9a-f]{32}-\d+"?$/.test(String(g.etag ?? "")) ? `md5-dash-${String(g.etag).replace(/"/g, "").split("-")[1]}` : /^"?[0-9a-f]{32}"?$/.test(String(g.etag ?? "")) ? "32-hex" : "other";
        await sizeRows("huge-tus.bin", m);
        m.delete = await del("pub", ["huge-tus.bin"]);
        out.push({ id: "SS11d", title: "2304 MiB through TUS (6 MiB chunks): completes, full GET hash, recorded size", status: fin?.ok && g.ok && g.sha256 === fx.huge.sha256 ? "pass" : "fail", detail: `${m.outcome}; ${m.upload_mbps} MB/s; sha ${m.get_sha256_equals_fixture}; size ${m.metadata_size}`, measurements: m });
      }
    } catch (e) {
      out.push({ id: "SS11", title: "SS11 aborted", status: "fail", detail: `threw: ${(e as Error).message}` });
    } finally {
      if (ref) {
        const d = await teardown(ctx, ref);
        out.push({ id: "SS11_teardown", title: "project deleted", status: d >= 200 && d < 300 ? "info" : "fail", detail: `DELETE HTTP ${d}` });
      }
    }
    return out;
  },
};

export default mod;
