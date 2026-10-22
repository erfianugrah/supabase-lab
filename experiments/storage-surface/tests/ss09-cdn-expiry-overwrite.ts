/**
 * SS09 - what the CDN keeps serving: a signed URL past its token expiry, an
 * object deleted behind a cached signed URL, an object overwritten in place,
 * and the Cache-Control the read paths return.
 *
 * SS08 measured a reused signed URL over three reads and `download()` with a
 * one-year `cacheControl`. Not run there or in SS03: a cached signed URL read
 * after its token expired (the Smart CDN page says the cached response keeps
 * being served until the CDN cache duration ends, and advises deleting the
 * object to cut access), whether deleting the object stops that, how long an
 * upsert in place stays stale on `/object/public` and on a reused signed URL
 * (SS03e saw stale bytes on `/object/authenticated` after an S3 overwrite;
 * I06 saw stale render variants), and the Cache-Control header on the public
 * URL and on a signed URL for a one-year `cacheControl`.
 *
 * One throwaway Pro-org project `ss-ss09-<epoch>` in ap-southeast-1, deleted
 * in `finally`. Gateway host only. Buckets `pub` (public) and `priv`
 * (private), each with a select policy for any authenticated user; signed
 * URLs are created with the service key.
 *
 *   SS09_setup  storage version, buckets, policies
 *   SS09a       priv: three signed URLs (expiresIn 30-32) each read until
 *               the edge answers HIT, at most 12 reads; a control URL signed at the same time
 *               and never read; all read 45 s after signing
 *   SS09d       priv: a signed URL (expiresIn 3600) warmed to HIT, the
 *               object deleted, the URL polled every 5 s for 120 s
 *   SS09b       upsert in place: three pub keys read through the public URL,
 *               two priv keys through one reused signed URL; v1 is 1,000 B,
 *               v2 2,000 B; after a confirmed upsert each is polled every 5 s
 *               for 180 s, recording the first read that returns v2
 *   SS09c       Cache-Control and cf-cache-status for cacheControl 3600 and
 *               31536000 on the public URL and on a signed URL
 *
 * All rows are `info`. Not settled: other regions or vantages (one client in
 * Singapore, one PoP), eviction past these windows, objects over a few KB,
 * repeat runs unless the module is run again.
 *
 * DESTRUCTIVE: one project, deleted in finally. Cost: about seven minutes of
 * Micro compute and, estimated from the read count, under 1 MB of egress.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmtSql, provision, sleep, teardown, type Proj } from "../lib";

interface Read {
  status: number;
  cf: string;
  cc: string;
  bytes: number;
}

const line = (r: Read) => `${r.status} cf=${r.cf || "-"} cc=${r.cc || "-"} bytes=${r.bytes}`;

async function get(url: string): Promise<Read> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, cf: r.headers.get("cf-cache-status") ?? "", cc: r.headers.get("cache-control") ?? "", bytes: b.length };
  } catch (e) {
    return { status: 0, cf: `err ${(e as Error).name}`, cc: "", bytes: 0 };
  }
}

const mod: TestModule = {
  id: "SS09",
  title: "CDN: signed URL past expiry, delete behind a cached URL, upsert staleness, Cache-Control per path",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SS09", title: "SS09", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let p: Proj | undefined;
    let ref = "";
    try {
      try {
        p = await provision(ctx, org, "ss09");
        ref = p.ref;
      } catch (e) {
        ref = (e as { ref?: string }).ref ?? "";
        throw e;
      }
      const rest = `${p.apiBase}/storage/v1`;
      const svc = { apikey: p.service, Authorization: `Bearer ${p.service}` };
      const setup: Record<string, string | number> = {};
      setup.storage_version = ((await fetch(`${rest}/version`).then((r) => r.text()).catch(() => "")).slice(0, 40)) || "unknown";
      for (const [id, pub] of [["pub", true], ["priv", false]] as const) {
        const r = await fetch(`${rest}/bucket`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/json" },
          body: JSON.stringify({ id, name: id, public: pub }),
        });
        setup[`bucket_${id}`] = r.status;
      }
      setup.policies = (await mgmtSql(ctx, ref, `create policy ss09_read on storage.objects for select to authenticated using (bucket_id in ('pub','priv'))`)).status;
      out.push({ id: "SS09_setup", title: "project, buckets, policies", status: "info", detail: `storage ${setup.storage_version}`, measurements: setup });

      let n = 0;
      const put = async (bucket: string, key: string, size: number, fill: string, cacheControl = "3600") => {
        const r = await fetch(`${rest}/object/${bucket}/${key}`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/octet-stream", "cache-control": `max-age=${cacheControl}`, "x-upsert": "true" },
          body: fill.repeat(size),
        });
        if (r.status !== 200) throw new Error(`upload ${bucket}/${key}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
        return r.status;
      };
      const newKey = () => `ss09/${Date.now()}-${n++}.bin`;
      const sign = async (bucket: string, key: string, expiresIn: number) => {
        const r = await fetch(`${rest}/object/sign/${bucket}/${key}`, {
          method: "POST",
          headers: { ...svc, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn }),
        });
        const j = (await r.json().catch(() => ({}))) as { signedURL?: string };
        if (!j.signedURL) throw new Error(`sign ${bucket}/${key}: HTTP ${r.status}`);
        return `${rest}${j.signedURL}`;
      };
      const pubUrl = (key: string) => `${rest}/object/public/pub/${key}`;

      // Read until the edge answers HIT (run 1 of this module warmed one URL
      // six times and saw MISS then REVALIDATED five times, an origin round trip
      // that cannot show what a cached copy does), at most 12 reads.
      const warmToHit = async (url: string) => {
        const seq: string[] = [];
        for (let i = 0; i < 12; i++) {
          const r = await get(url);
          seq.push(`${r.status}/${r.cf || "-"}`);
          if (r.cf === "HIT") break;
          await sleep(1500);
        }
        return seq.join(" ");
      };

      // ---- SS09a: signed URL past expiry ----
      {
        const m: Record<string, string | number> = { expires_in_s: 30 };
        const keys = await Promise.all([1, 2, 3].map(async () => {
          const k = newKey();
          await put("priv", k, 1000, "a");
          return k;
        }));
        const signedAt = Date.now();
        const urls = await Promise.all(keys.map((k, i) => sign("priv", k, 30 + i)));
        const control = await sign("priv", keys[0]!, 33);
        const warmed = await Promise.all(urls.map((u) => warmToHit(u)));
        warmed.forEach((s, i) => (m[`url${i + 1}_warm`] = s));
        await sleep(Math.max(0, signedAt + 45_000 - Date.now()));
        m.after_expiry_s = Math.round((Date.now() - signedAt) / 1000);
        for (let i = 0; i < urls.length; i++) m[`url${i + 1}_after_expiry`] = line(await get(urls[i]!));
        m.control_never_read_after_expiry = line(await get(control));
        const servedAfter = urls.filter((_, i) => String(m[`url${i + 1}_after_expiry`]).startsWith("200")).length;
        out.push({
          id: "SS09a",
          title: "private bucket: signed URL read until HIT (at most 12 reads), read again after its token expired",
          status: "info",
          detail: `${servedAfter} of ${urls.length} warmed URLs served after expiry; control ${m.control_never_read_after_expiry}`,
          measurements: m,
        });
      }

      // ---- SS09d: delete behind a cached, unexpired signed URL ----
      {
        const m: Record<string, string | number> = {};
        const k = newKey();
        await put("priv", k, 1000, "a");
        const u = await sign("priv", k, 3600);
        m.warm = await warmToHit(u);
        const del = await fetch(`${rest}/object/priv/${k}`, { method: "DELETE", headers: svc });
        m.delete_status = del.status;
        const at = Date.now();
        const trace: string[] = [];
        let firstGone = -1;
        while (Date.now() - at < 120_000) {
          const r = await get(u);
          const t = Math.round((Date.now() - at) / 1000);
          trace.push(`${t}s:${r.status}/${r.cf || "-"}/${r.bytes}`);
          if (firstGone < 0 && r.bytes !== 1000) firstGone = t;
          await sleep(5000);
        }
        m.trace = trace.join(" ");
        m.first_not_served_s = firstGone;
        out.push({ id: "SS09d", title: "private bucket: object deleted behind a cached signed URL (expiresIn 3600)", status: "info", detail: `first read not serving the object at ${firstGone}s (-1 = not within 120 s)`, measurements: m });
      }

      // ---- SS09b: upsert in place ----
      {
        const m: Record<string, string | number> = {};
        type Trial = { label: string; url: string; bucket: string; key: string };
        const trials: Trial[] = [];
        for (let i = 1; i <= 3; i++) {
          const key = newKey();
          await put("pub", key, 1000, "a");
          trials.push({ label: `public_${i}`, url: pubUrl(key), bucket: "pub", key });
        }
        for (let i = 1; i <= 2; i++) {
          const key = newKey();
          await put("priv", key, 1000, "a");
          trials.push({ label: `signed_reused_${i}`, url: await sign("priv", key, 3600), bucket: "priv", key });
        }
        await Promise.all(
          trials.map(async (tr) => {
            const warm: string[] = [];
            for (let i = 0; i < 4; i++) {
              const r = await get(tr.url);
              warm.push(`${r.status}/${r.cf || "-"}/${r.bytes}`);
              await sleep(1500);
            }
            m[`${tr.label}_warm`] = warm.join(" ");
            m[`${tr.label}_upsert_status`] = await put(tr.bucket, tr.key, 2000, "b");
            const at = Date.now();
            const trace: string[] = [];
            let firstNew = -1;
            while (Date.now() - at < 180_000) {
              const r = await get(tr.url);
              const t = Math.round((Date.now() - at) / 1000);
              trace.push(`${t}s:${r.cf || "-"}/${r.bytes}`);
              if (firstNew < 0 && r.bytes === 2000) firstNew = t;
              await sleep(5000);
            }
            m[`${tr.label}_first_v2_s`] = firstNew;
            m[`${tr.label}_trace`] = trace.join(" ");
          }),
        );
        const firsts = trials.map((tr) => `${tr.label}=${m[`${tr.label}_first_v2_s`]}`).join(", ");
        out.push({ id: "SS09b", title: "upsert in place: seconds until the read returns the new bytes (-1 = not within 180 s)", status: "info", detail: firsts, measurements: m });
      }

      // ---- SS09c: Cache-Control per path ----
      {
        const m: Record<string, string> = {};
        for (const cc of ["3600", "31536000"]) {
          const kp = newKey();
          await put("pub", kp, 1000, "a", cc);
          m[`public_cc${cc}_1`] = line(await get(pubUrl(kp)));
          await sleep(1500);
          m[`public_cc${cc}_2`] = line(await get(pubUrl(kp)));
          const ks = newKey();
          await put("priv", ks, 1000, "a", cc);
          const u = await sign("priv", ks, 3600);
          m[`signed_cc${cc}_1`] = line(await get(u));
          await sleep(1500);
          m[`signed_cc${cc}_2`] = line(await get(u));
        }
        out.push({ id: "SS09c", title: "Cache-Control returned per path for cacheControl 3600 and 31536000", status: "info", measurements: m });
      }
    } catch (e) {
      out.push({ id: "SS09", title: "SS09 aborted", status: "fail", detail: `threw: ${(e as Error).message}` });
    } finally {
      if (ref) {
        const del = await teardown(ctx, ref);
        out.push({ id: "SS09_teardown", title: "project deleted", status: del >= 200 && del < 300 ? "info" : "fail", detail: `DELETE HTTP ${del}` });
      }
    }
    return out;
  },
};

export default mod;
