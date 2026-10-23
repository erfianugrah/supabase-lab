/**
 * PT06 - Can a detached partition be moved to Supabase Storage and read back
 * for a lookup, using only generally available pieces?
 *
 * SIDE: managed Pro-org Micro project (lib/project.ts). KEYS: SQL as postgres
 * through the Management query endpoint and through psql on the session
 * pooler (port 5432); Storage REST with the legacy service_role JWT; Data API
 * reads with the legacy anon JWT. Analytics buckets / Iceberg are alpha and
 * are not used.
 *
 * Table public.cs_events range by month; partition 2026_06 holds 1,000,000
 * rows (tenants 1-50, spread over the 43200 minutes of June by g % 43200,
 * about 23 rows a minute, short text payload). It
 * is detached, exported twice (n = 2) as gzip CSV with psql `\copy ... to
 * pstdout`, each copy uploaded to a private bucket `archive` through the
 * Storage REST API, and the table is dropped. Then:
 *
 *   PT06a  setup: rows, checksum (count + sum of hashtextextended(row::text)),
 *          the Storage global file size limit, and a filtered lookup (tenant
 *          7, one day) on the detached table before the drop, as the
 *          baseline (execution time from EXPLAIN ANALYZE, median of 5).
 *   PT06b  export + upload per rep: psql export ms, gzip object bytes,
 *          upload status and ms.
 *   PT06c  the Wrappers S3 FDW against the bucket. The documented Supabase
 *          Storage form needs S3 access keys from the dashboard; the
 *          Management API has no endpoint for them (the v1 OpenAPI document
 *          lists config/storage and storage/buckets only), so this row
 *          records (1) the status of the dashboard's credential route with a
 *          PAT and (2) each credential form a test can produce: access key id
 *          = project ref with the anon key or the service_role key as secret
 *          (the session-token shape, without the token the FDW cannot send),
 *          on the storage host and on the gateway host. Exact errors.
 *   PT06d  fallback per rep: download through Storage REST, gunzip, psql
 *          `\copy ... from pstdin` into archive.cs_restore_rN (schema not
 *          exposed): download ms, import ms, row count and checksum equal to
 *          the original, the same filtered lookup unindexed and after an
 *          index on (tenant_id, created_at), and anon Data API reads at the
 *          default profile and with Accept-Profile: archive.
 *
 * All rows `info` except PT06d's checksum equality, which fails if the
 * restored rows differ from the original.
 *
 * DESTRUCTIVE: creates tables, a bucket, extension wrappers and FDW servers on
 * the shared PT project; PT99 deletes the project. Local gzip files go to the
 * gitignored evidence/tmp-pt06/ and are deleted at the end.
 *
 * Not settled here: Parquet; objects over the file size limit (multipart or
 * TUS); dashboard-generated S3 keys with the FDW (no API to create them);
 * restore of larger partitions or on larger compute.
 */
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { brief, currentProject, ensureProject, median, pgSession, rest, skipWithoutPro, sql, sqlOk, type PtProject } from "../lib/project.js";

const BUCKET = "archive";
const PART = "cs_events_2026_06";
const LOOKUP = (t: string) => `select count(*) from ${t} where tenant_id = 7 and created_at >= '2026-06-15' and created_at < '2026-06-16'`;
const LOOKUP_TEXT = (t: string) => `select count(*) from ${t} where tenant_id = '7' and created_at >= '2026-06-15' and created_at < '2026-06-16'`;
const CHECKSUM = (t: string) => `select count(*)::bigint as n, sum(hashtextextended(x::text, 0))::text as h from (select id, tenant_id, created_at, payload from ${t}) x`;
const TMP = join(import.meta.dir, "..", "evidence", "tmp-pt06");

/** Run a bash pipeline with the db password in the environment only. */
async function sh(p: PtProject, cmd: string): Promise<{ code: number; ms: number; err: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn(["bash", "-o", "pipefail", "-c", cmd], {
    env: { ...process.env, PGPASSWORD: p.dbPass, PGSSLMODE: "require", PGCONNECT_TIMEOUT: "30" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, ms: Math.round(performance.now() - t0), err: err.trim() };
}

const conn = (p: PtProject) => `psql "host=${p.poolerHost} port=5432 user=${p.poolerUser} dbname=postgres" -X -q -v ON_ERROR_STOP=1 -c "set timezone to 'UTC'"`;

/** Median EXPLAIN ANALYZE execution time over 5 runs, and the count the query returns. */
async function lookup(p: PtProject, q: string): Promise<{ execMs: number; count: number; error: string }> {
  const s = await pgSession(p);
  const times: number[] = [];
  let error = "";
  for (let i = 0; i < 5; i++) {
    const r = await s.query(`explain (analyze, format json) ${q}`);
    if (r.error) {
      error = r.error;
      break;
    }
    const plan = (r.rows[0]?.["QUERY PLAN"] as { "Execution Time"?: number }[] | undefined)?.[0];
    times.push(Math.round((plan?.["Execution Time"] ?? -1) * 100) / 100);
  }
  const c = error ? { rows: [] as Record<string, unknown>[] } : await s.query(q);
  await s.close();
  return { execMs: median(times), count: Number(c.rows[0]?.count ?? -1), error };
}

const mod: TestModule = {
  id: "PT06",
  title: "Detached partition to Storage and back, on generally available pieces",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "PT06");
    if (skip) return skip;
    const results: TestResult[] = [];
    let p: PtProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "PT06", title: "PT06", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const scrub = (s: string) => brief(currentProject(), s.replaceAll(p.keys.anon, "<anon-key>").replaceAll(p.keys.service, "<service-key>"), 300);
    mkdirSync(TMP, { recursive: true });
    try {
      // ---- PT06a: setup and baseline ----
      const t0 = Date.now();
      await sqlOk(
        ctx,
        p.ref,
        `create schema if not exists archive;
         create table public.cs_events (
           id bigint generated by default as identity,
           tenant_id int not null,
           created_at timestamptz not null,
           payload text,
           primary key (created_at, id)
         ) partition by range (created_at);
         alter table public.cs_events enable row level security;
         create policy tenant_read on public.cs_events for select to authenticated
           using (tenant_id = (select (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::int));
         create table public.${PART} partition of public.cs_events for values from ('2026-06-01') to ('2026-07-01');
         create table public.cs_events_2026_10 partition of public.cs_events for values from ('2026-10-01') to ('2026-11-01');`,
      );
      await sqlOk(
        ctx,
        p.ref,
        `insert into public.cs_events (tenant_id, created_at, payload)
         select 1 + (g % 50), timestamptz '2026-06-01 00:00:00+00' + make_interval(mins => g % 43200), 'action=' || (g % 17) || ' ref=' || (g % 9973)
         from generate_series(1, 1000000) g`,
      );
      const loadS = Math.round((Date.now() - t0) / 1000);
      await sqlOk(ctx, p.ref, `alter table public.cs_events detach partition public.${PART}; analyze public.${PART};`);
      const orig = (await sqlOk(ctx, p.ref, CHECKSUM(`public.${PART}`)))[0] ?? {};
      const relSize = (await sqlOk(ctx, p.ref, `select pg_total_relation_size('public.${PART}')::bigint as b`))[0]?.b;
      const base = await lookup(p, LOOKUP(`public.${PART}`));
      const scfg = await mgmt(ctx, "GET", `/projects/${p.ref}/config/storage`);
      const fileLimit = Number((scfg.json as { fileSizeLimit?: number } | undefined)?.fileSizeLimit ?? -1);
      const bucket = await rest(p.host, "/storage/v1/bucket", p.keys.service, { method: "POST", body: { id: BUCKET, name: BUCKET, public: false } });
      results.push({
        id: "PT06a",
        title: "PT06a: 1,000,000-row partition detached; checksum and baseline lookup",
        status: "info",
        detail: `load ${loadS}s; rows ${String(orig.n)}; table+index ${String(relSize)} bytes; lookup (tenant 7, one day, PK index) exec median ${base.execMs} ms -> ${base.count} rows ${scrub(base.error)}; storage fileSizeLimit ${fileLimit} bytes (config ${scfg.status}); bucket create ${bucket.status}`,
        measurements: {
          rows: Number(orig.n ?? -1),
          checksum: String(orig.h ?? ""),
          relation_bytes: Number(relSize ?? -1),
          baseline_lookup_exec_ms: base.execMs,
          baseline_lookup_rows: base.count,
          storage_file_size_limit_bytes: fileLimit,
          bucket_create_status: bucket.status,
        },
      });

      // ---- PT06b: export + upload, n = 2 ----
      const objects: string[] = [];
      for (const rep of [1, 2]) {
        const file = join(TMP, `${PART}-r${rep}.csv.gz`);
        const ex = await sh(p, `${conn(p)} -c "\\copy (select id, tenant_id, created_at, payload from public.${PART} order by created_at, id) to pstdout with (format csv, header)" | gzip -c > '${file}'`);
        const bytes = ex.code === 0 ? statSync(file).size : -1;
        const obj = `${PART}-r${rep}.csv.gz`;
        const up0 = performance.now();
        const up = await fetch(`https://${p.host}/storage/v1/object/${BUCKET}/${obj}`, {
          method: "POST",
          headers: { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}`, "Content-Type": "application/gzip", "x-upsert": "true" },
          body: Bun.file(file),
          signal: AbortSignal.timeout(300_000),
        }).catch((e) => new Response(String(e), { status: 0 }));
        const upMs = Math.round(performance.now() - up0);
        const upBody = await up.text();
        if (up.status === 200) objects.push(obj);
        results.push({
          id: `PT06b-r${rep}`,
          title: `PT06b: export to gzip CSV and upload to a private bucket (rep ${rep})`,
          status: "info",
          detail: `export exit ${ex.code} ${ex.ms} ms ${scrub(ex.err)}; object ${bytes} bytes; upload ${up.status} ${upMs} ms ${up.status === 200 ? "" : scrub(upBody)}`,
          measurements: { export_exit: ex.code, export_ms: ex.ms, object_bytes: bytes, upload_status: up.status, upload_ms: upMs },
        });
      }
      await sqlOk(ctx, p.ref, `drop table public.${PART}`);

      // ---- PT06c: Wrappers S3 FDW against Storage ----
      const plat = await fetch(`https://api.supabase.com/platform/storage/${p.ref}/credentials`, {
        headers: { Authorization: `Bearer ${ctx.pat}` },
        signal: AbortSignal.timeout(30_000),
      }).catch((e) => new Response(String(e), { status: 0 }));
      const platBody = scrub(await plat.text());
      const wr = await sql(
        ctx,
        p.ref,
        `create extension if not exists wrappers with schema extensions;
         do $$ begin
           if not exists (select 1 from pg_foreign_data_wrapper where fdwname = 's3_wrapper') then
             create foreign data wrapper s3_wrapper handler s3_fdw_handler validator s3_fdw_validator;
           end if;
         end $$;`,
      );
      const wver = await sql(ctx, p.ref, `select extversion as v from pg_extension where extname = 'wrappers'`);
      const obj1 = objects[0] ?? `${PART}-r1.csv.gz`;
      const variants = [
        { id: "v1", key: p.ref, secret: p.keys.anon, host: `${p.ref}.storage.supabase.co`, label: "ref + anon key, storage host" },
        { id: "v2", key: p.ref, secret: p.keys.anon, host: `${p.ref}.supabase.co`, label: "ref + anon key, gateway host" },
        { id: "v3", key: p.ref, secret: p.keys.service, host: `${p.ref}.storage.supabase.co`, label: "ref + service_role key, storage host" },
      ];
      const fdwOut: string[] = [];
      const fdwMeas: Record<string, string | number> = {};
      let fdwWorking = "";
      for (const v of variants) {
        const setup = await sql(
          ctx,
          p.ref,
          `create server s3_${v.id} foreign data wrapper s3_wrapper options (
             aws_access_key_id '${v.key}', aws_secret_access_key '${v.secret}', aws_region '${"ap-southeast-1"}',
             endpoint_url 'https://${v.host}/storage/v1/s3', path_style_url 'true');
           create foreign table archive.cs_s3_${v.id} (id text, tenant_id text, created_at text, payload text)
             server s3_${v.id} options (uri 's3://${BUCKET}/${obj1}', format 'csv', has_header 'true', compress 'gzip');`,
        );
        const q0 = performance.now();
        const q = await sql(ctx, p.ref, `select count(*)::bigint as n from archive.cs_s3_${v.id}`);
        const qMs = Math.round(performance.now() - q0);
        const n = Number(q.rows?.[0]?.n ?? -1);
        const err = scrub(setup.error ?? q.error ?? "");
        fdwOut.push(`${v.label}: ${q.status < 300 ? `count ${n} in ${qMs} ms` : `${q.status} ${err}`}`);
        fdwMeas[`${v.id}_status`] = q.status;
        fdwMeas[`${v.id}_rows`] = n;
        fdwMeas[`${v.id}_error`] = err.slice(0, 160);
        if (q.status < 300 && n > 0 && !fdwWorking) fdwWorking = v.id;
      }
      let fdwLookup = { execMs: -1, count: -1, error: "" };
      if (fdwWorking) fdwLookup = await lookup(p, LOOKUP_TEXT(`archive.cs_s3_${fdwWorking}`));
      results.push({
        id: "PT06c",
        title: "PT06c: Wrappers S3 FDW reading the archived object from Storage",
        status: "info",
        detail: `dashboard credential route with a PAT: ${plat.status} ${platBody.slice(0, 120)}; wrappers ${wr.status} ${scrub(wr.error ?? "")} version ${String(wver.rows?.[0]?.v ?? "")}; ${fdwOut.join("; ")}${fdwWorking ? `; lookup via ${fdwWorking} exec median ${fdwLookup.execMs} ms -> ${fdwLookup.count}` : ""}`,
        measurements: {
          platform_credentials_status: plat.status,
          wrappers_status: wr.status,
          wrappers_version: String(wver.rows?.[0]?.v ?? ""),
          ...fdwMeas,
          fdw_working_variant: fdwWorking || "none",
          fdw_lookup_exec_ms: fdwLookup.execMs,
          fdw_lookup_rows: fdwLookup.count,
        },
      });

      // ---- PT06d: download + COPY FROM fallback, n = 2 ----
      for (const [i, obj] of objects.entries()) {
        const rep = i + 1;
        const file = join(TMP, `dl-${obj}`);
        const dl0 = performance.now();
        const dl = await fetch(`https://${p.host}/storage/v1/object/${BUCKET}/${obj}`, {
          headers: { apikey: p.keys.service, Authorization: `Bearer ${p.keys.service}` },
          signal: AbortSignal.timeout(300_000),
        }).catch((e) => new Response(String(e), { status: 0 }));
        if (dl.status === 200) await Bun.write(file, await dl.arrayBuffer());
        const dlMs = Math.round(performance.now() - dl0);
        const tbl = `archive.cs_restore_r${rep}`;
        await sqlOk(ctx, p.ref, `create table ${tbl} (id bigint, tenant_id int, created_at timestamptz, payload text)`);
        const im = dl.status === 200 ? await sh(p, `gunzip -c '${file}' | ${conn(p)} -c "\\copy ${tbl} from pstdin with (format csv, header)"`) : { code: -1, ms: -1, err: `download ${dl.status}` };
        const got = (await sqlOk(ctx, p.ref, CHECKSUM(tbl)))[0] ?? {};
        const equal = String(got.n) === String(orig.n) && String(got.h) === String(orig.h);
        await sqlOk(ctx, p.ref, `analyze ${tbl}`);
        const unidx = await lookup(p, LOOKUP(tbl));
        const ix0 = performance.now();
        await sqlOk(ctx, p.ref, `create index on ${tbl} (tenant_id, created_at)`);
        const ixMs = Math.round(performance.now() - ix0);
        const idx = await lookup(p, LOOKUP(tbl));
        await sql(ctx, p.ref, "notify pgrst, 'reload schema'");
        await new Promise((r) => setTimeout(r, 5_000));
        const aDef = await rest(p.host, `/rest/v1/cs_restore_r${rep}?select=id&limit=1`, p.keys.anon);
        const aArch = await rest(p.host, `/rest/v1/cs_restore_r${rep}?select=id&limit=1`, p.keys.anon, { headers: { "Accept-Profile": "archive" } });
        const code = (r: { json?: unknown; status: number }) => ((r.json as { code?: string } | undefined)?.code ?? "") || String(r.status);
        results.push({
          id: `PT06d-r${rep}`,
          title: `PT06d: download and COPY FROM into a non-exposed schema (rep ${rep})`,
          status: equal ? "info" : "fail",
          detail: `download ${dl.status} ${dlMs} ms; import exit ${im.code} ${im.ms} ms ${scrub(im.err)}; rows ${String(got.n)} checksum ${equal ? "equal" : "DIFFERENT"}; lookup unindexed exec median ${unidx.execMs} ms -> ${unidx.count}, index build ${ixMs} ms, indexed ${idx.execMs} ms -> ${idx.count}; anon default profile ${aDef.status}/${code(aDef)}, Accept-Profile archive ${aArch.status}/${code(aArch)}`,
          measurements: {
            download_status: dl.status,
            download_ms: dlMs,
            import_exit: im.code,
            import_ms: im.ms,
            restored_rows: Number(got.n ?? -1),
            checksum_equal: equal ? 1 : 0,
            lookup_unindexed_exec_ms: unidx.execMs,
            lookup_unindexed_rows: unidx.count,
            index_build_ms: ixMs,
            lookup_indexed_exec_ms: idx.execMs,
            lookup_indexed_rows: idx.count,
            anon_default_status: aDef.status,
            anon_default_code: code(aDef),
            anon_archive_profile_status: aArch.status,
            anon_archive_profile_code: code(aArch),
          },
        });
      }
    } catch (e) {
      results.push({ id: "PT06", title: "PT06", status: "fail", detail: scrub(e instanceof Error ? e.message : String(e)) });
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
    return results;
  },
};
export default mod;
