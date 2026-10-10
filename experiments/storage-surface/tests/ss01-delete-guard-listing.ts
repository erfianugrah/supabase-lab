/**
 * SS01 - Storage's direct-SQL delete guard, the orphan question, and
 * cursor vs offset listing, on one throwaway Pro project.
 *
 * Claims under test (public sources, not measured by reading them):
 *   - a statement-level trigger rejects DELETE on storage tables unless
 *     `storage.allow_delete_query` is 'true'
 *   - `storage.prefixes` was dropped
 *   - cursor pagination is "up to 14.8x faster" for deep pages
 *   Source for all three, a blog post dated 5 March 2026:
 *   https://supabase.com/blog/supabase-storage-performance-security-reliability-updates
 *   The 14.8x figure is the post's benchmark on a 60-million-row table; this
 *   module uses 5,000 to 100,000 rows and does not reproduce that setup.
 *   Orphaning by SQL delete is documented at
 *   https://supabase.com/docs/guides/storage/management/delete-objects
 *
 *   SS01a  what is there: storage.prefixes present?, storage tables, delete
 *          triggers (name, level), storage server version, migration count
 *   SS01b  the guard: DELETE refused as postgres on a matching row, on
 *          `where false`, on storage.buckets; accepted spellings of the
 *          setting; Management API vs a pooler session; TRUNCATE (inside a
 *          rolled-back transaction)
 *   SS01c  the orphan question. Storage's read path takes the backing key
 *          from the row (bucket, name, version). So: capture a row, delete
 *          it with the guard off, re-insert the same row. If the REST/S3
 *          read then returns the original bytes, the backing object
 *          survived the SQL delete. Controls: the same dance after an API
 *          DELETE (backing object removed -> read must fail), and a
 *          re-insert with a different `version` (must fail).
 *   SS01d  listing: v1 (limit/offset) vs v2 (cursor) on 5,000, 25,000 and
 *          100,000 rows. Per-depth latency, whole-prefix walk, DB-side time of the
 *          two storage functions. Rows are INSERTed with SQL, so this
 *          times the listing query path only (no backing objects exist).
 *
 * Deletes its project in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  type Proj,
  authHeaders,
  median,
  missingTools,
  mgmtSql,
  pct,
  pgSession,
  provision,
  r1,
  s3cfg,
  s3ops,
  teardown,
  timed,
} from "../lib";

const BUCKET = "ss";
const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");
const UNIQ = crypto.randomUUID().slice(0, 8);

type Fetched = { status: number; text: string; ms: number };
async function rest(p: Proj, method: string, path: string, body?: unknown, raw?: { body: string; type: string }): Promise<Fetched> {
  const { ms, v } = await timed(async () => {
    const res = await fetch(`${p.apiBase}/storage/v1${path}`, {
      method,
      headers: authHeaders(p.service, raw ? { "Content-Type": raw.type } : body ? { "Content-Type": "application/json" } : {}),
      body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, text: await res.text() };
  });
  return { ...v, ms };
}

const short = (s: string, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

/** Try one statement on a pg client; return the error text or "OK(n)". */
async function attempt(c: import("pg").Client, sql: string): Promise<string> {
  try {
    const r = await c.query(sql);
    return `OK(${r.rowCount ?? 0})`;
  } catch (e) {
    return `ERR ${(e as { code?: string }).code ?? ""} ${short((e as Error).message, 120)}`;
  }
}

const mod: TestModule = {
  id: "SS01",
  title: "Storage delete guard, orphans, prefixes table, v1 vs v2 listing",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SS01", title: "SS01", status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = missingTools(["bun"]);
    if (missing.length) return [{ id: "SS01", title: "SS01", status: "skip", detail: `required tool not on PATH: ${missing.join(", ")}` }];
    const out: TestResult[] = [];
    const ids = ["SS01a", "SS01b", "SS01c", "SS01d"];
    let ref = "";
    let pgc: import("pg").Client | undefined;
    try {
      let proj: Proj;
      try {
        proj = await provision(ctx, org, "ss01");
      } catch (e) {
        ref = (e as { ref?: string }).ref ?? "";
        throw e;
      }
      ref = proj.ref;
      pgc = await pgSession(ctx, proj);
      const c = pgc;
      await rest(proj, "POST", "/bucket", { id: BUCKET, name: BUCKET, public: false });

      // ---------------- SS01a ----------------
      const prefixes = await mgmtSql(ctx, ref, "select to_regclass('storage.prefixes')::text as t");
      const tables = await mgmtSql(
        ctx,
        ref,
        "select string_agg(table_name, ',' order by table_name) t from information_schema.tables where table_schema='storage'",
      );
      const trig = await mgmtSql(
        ctx,
        ref,
        "select string_agg(tgrelid::regclass::text || '.' || tgname || ':' || case when tgtype & 1 = 1 then 'row' else 'stmt' end || '/' || case when tgtype & 2 = 2 then 'before' else 'after' end || '/' || case when tgtype & 8 = 8 then 'delete' else 'other' end, ' | ' order by tgname) t from pg_trigger where tgrelid in ('storage.objects'::regclass,'storage.buckets'::regclass) and tgname like 'protect_%delete'",
      );
      const mig = await mgmtSql(ctx, ref, "select count(*)::int n, (select name from storage.migrations order by id desc limit 1) last from storage.migrations");
      const ver = await rest(proj, "GET", "/version");
      const pgv = await mgmtSql(ctx, ref, "select current_setting('server_version') v");
      out.push({
        id: "SS01a",
        title: "SS01a: storage schema facts",
        status: prefixes.rows[0]?.t === null ? "pass" : "info",
        detail: "pass = storage.prefixes absent",
        measurements: {
          prefixes_table: String(prefixes.rows[0]?.t ?? "absent"),
          storage_tables: String(tables.rows[0]?.t ?? ""),
          delete_triggers: String(trig.rows[0]?.t ?? ""),
          storage_version: short(ver.text, 30),
          migrations: Number(mig.rows[0]?.n ?? -1),
          last_migration: String(mig.rows[0]?.last ?? ""),
          pg_version: String(pgv.rows[0]?.v ?? ""),
        },
      });

      // ---------------- SS01b ----------------
      const m: Record<string, number | string> = {};
      const viaApi = await mgmtSql(ctx, ref, "delete from storage.objects where bucket_id = 'nonexistent-bucket'");
      m.mgmt_api_delete_matching = `${viaApi.status} ${short(viaApi.text, 90)}`;
      m.pooler_delete_where_false = await attempt(c, "delete from storage.objects where false");
      m.pooler_delete_buckets_where_false = await attempt(c, "delete from storage.buckets where false");
      m.pooler_set_on = await (async () => {
        await c.query("set storage.allow_delete_query = 'on'");
        const r = await attempt(c, "delete from storage.objects where false");
        await c.query("reset storage.allow_delete_query");
        return r;
      })();
      m.pooler_set_TRUE = await (async () => {
        await c.query("set storage.allow_delete_query = 'TRUE'");
        const r = await attempt(c, "delete from storage.objects where false");
        await c.query("reset storage.allow_delete_query");
        return r;
      })();
      m.pooler_set_true = await (async () => {
        await c.query("set storage.allow_delete_query = 'true'");
        const r = await attempt(c, "delete from storage.objects where false");
        await c.query("reset storage.allow_delete_query");
        return r;
      })();
      m.pooler_set_local_true_in_txn = await (async () => {
        await c.query("begin");
        await c.query("set local storage.allow_delete_query = 'true'");
        const r = await attempt(c, "delete from storage.objects where false");
        await c.query("commit");
        const after = await attempt(c, "delete from storage.objects where false");
        return `${r}; after commit: ${after}`;
      })();
      const apiSet = await mgmtSql(ctx, ref, "set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'nonexistent-bucket'");
      m.mgmt_api_set_then_delete = `${apiSet.status} ${short(apiSet.text, 90)}`;
      // TRUNCATE has no row-level DELETE: probe inside a transaction we roll back.
      m.pooler_truncate_objects_in_rolled_back_txn = await (async () => {
        await c.query("begin");
        const r = await attempt(c, "truncate storage.objects");
        await c.query("rollback");
        return r;
      })();
      const refused = String(m.pooler_delete_where_false).startsWith("ERR 42501") && viaApi.status >= 400;
      out.push({
        id: "SS01b",
        title: "SS01b: DELETE on storage tables refused unless the setting is 'true'",
        status: refused ? "pass" : "fail",
        detail: refused ? undefined : "guard did not refuse",
        measurements: m,
      });

      // ---------------- SS01c ----------------
      const mc: Record<string, number | string> = {};
      const sCfg = s3cfg(proj);
      const names = {
        rest: `orphan/rest-${UNIQ}.txt`,
        s3: `orphan/s3-${UNIQ}.txt`,
        ctl: `orphan/control-${UNIQ}.txt`,
      };
      const bodies = { rest: `rest-body-${crypto.randomUUID()}`, s3: `s3-body-${crypto.randomUUID()}`, ctl: `ctl-body-${crypto.randomUUID()}` };
      const up = async (name: string, body: string) =>
        (await rest(proj, "POST", `/object/${BUCKET}/${enc(name)}`, undefined, { body, type: "text/plain" })).status;
      mc.upload_rest = await up(names.rest, bodies.rest);
      mc.upload_ctl = await up(names.ctl, bodies.ctl);
      const put = await s3ops(sCfg, [{ op: "put", bucket: BUCKET, key: names.s3, body: bodies.s3 }]);
      mc.upload_s3 = put[0]?.status ?? -1;
      const getRest = async (name: string) => {
        const r = await rest(proj, "GET", `/object/authenticated/${BUCKET}/${enc(name)}`);
        return { status: r.status, text: r.text };
      };
      const rowOf = async (name: string) => {
        const r = await c.query("select to_jsonb(o) - 'path_tokens' as j from storage.objects o where bucket_id=$1 and name=$2", [BUCKET, name]);
        return r.rows[0]?.j as Record<string, unknown> | undefined;
      };
      const reinsert = async (row: Record<string, unknown>, version?: string) => {
        const j = { ...row, ...(version ? { version } : {}) };
        const r = await c.query(
          "insert into storage.objects (id,bucket_id,name,owner,created_at,updated_at,last_accessed_at,metadata,version,owner_id,user_metadata,archived_at,is_delete_marker,is_versioned) select id,bucket_id,name,owner,created_at,updated_at,last_accessed_at,metadata,version,owner_id,user_metadata,archived_at,is_delete_marker,is_versioned from jsonb_populate_record(null::storage.objects, $1::jsonb)",
          [JSON.stringify(j)],
        );
        return r.rowCount ?? 0;
      };
      const sqlDelete = async (name: string) => {
        await c.query("set storage.allow_delete_query = 'true'");
        try {
          const r = await c.query("delete from storage.objects where bucket_id=$1 and name=$2", [BUCKET, name]);
          return r.rowCount ?? 0;
        } finally {
          await c.query("reset storage.allow_delete_query");
        }
      };
      const rowRest = await rowOf(names.rest);
      const rowS3 = await rowOf(names.s3);
      const rowCtl = await rowOf(names.ctl);
      mc.rows_captured = [rowRest, rowS3, rowCtl].filter(Boolean).length;
      mc.row_has_version = rowRest?.version ? "yes" : "no";

      // control: API delete removes the backing object; re-inserting the row must not bring bytes back
      const apiDel = await rest(proj, "DELETE", `/object/${BUCKET}/${enc(names.ctl)}`);
      mc.ctl_api_delete_status = apiDel.status;
      mc.ctl_rows_after_api_delete = Number((await c.query("select count(*)::int n from storage.objects where bucket_id=$1 and name=$2", [BUCKET, names.ctl])).rows[0]?.n);
      if (rowCtl) mc.ctl_reinsert_rows = await reinsert(rowCtl);
      const ctlGet = await getRest(names.ctl);
      mc.ctl_read_after_api_delete_and_reinsert = `${ctlGet.status} ${ctlGet.text === bodies.ctl ? "BYTES RETURNED" : short(ctlGet.text, 80)}`;
      if (rowCtl) await sqlDelete(names.ctl);

      // SQL delete of the REST-uploaded object and the S3-uploaded object
      const delRest = await sqlDelete(names.rest);
      const delS3 = await sqlDelete(names.s3);
      mc.sql_deleted_rows = `${delRest}+${delS3}`;
      const afterRest = await getRest(names.rest);
      mc.rest_read_after_sql_delete = `${afterRest.status} ${short(afterRest.text, 80)}`;
      const afterS3 = await s3ops(sCfg, [
        { op: "get", bucket: BUCKET, key: names.s3 },
        { op: "head", bucket: BUCKET, key: names.s3 },
        { op: "list", bucket: BUCKET, prefix: "orphan/" },
      ]);
      mc.s3_get_after_sql_delete = `${afterS3[0]?.status} ${afterS3[0]?.code}`;
      mc.s3_head_after_sql_delete = `${afterS3[1]?.status} ${afterS3[1]?.code}`;
      mc.s3_list_orphan_prefix_keys = (afterS3[2]?.keys ?? []).length;

      // discriminating control: same row, a different version -> read must fail
      if (rowRest) {
        mc.rest_reinsert_other_version_rows = await reinsert(rowRest, crypto.randomUUID());
        const wrongVer = await getRest(names.rest);
        mc.rest_read_other_version = `${wrongVer.status} ${wrongVer.text === bodies.rest ? "BYTES RETURNED" : short(wrongVer.text, 80)}`;
        await sqlDelete(names.rest);
      }
      // the probe: same row, the original version
      let orphanRest = "n/a";
      let orphanS3 = "n/a";
      if (rowRest) {
        mc.rest_reinsert_orig_version_rows = await reinsert(rowRest);
        const g = await getRest(names.rest);
        orphanRest = g.status === 200 && g.text === bodies.rest ? "yes" : "no";
        mc.rest_read_orig_version = `${g.status} ${g.text === bodies.rest ? "ORIGINAL BYTES" : short(g.text, 80)}`;
      }
      if (rowS3) {
        mc.s3_reinsert_orig_version_rows = await reinsert(rowS3);
        const g = await s3ops(sCfg, [{ op: "get", bucket: BUCKET, key: names.s3 }]);
        orphanS3 = g[0]?.ok && g[0].body === bodies.s3 ? "yes" : "no";
        mc.s3_read_orig_version = `${g[0]?.status} ${g[0]?.body === bodies.s3 ? "ORIGINAL BYTES" : g[0]?.code}`;
      }
      mc.backing_object_survived_rest = orphanRest;
      mc.backing_object_survived_s3 = orphanS3;
      out.push({
        id: "SS01c",
        title: "SS01c: SQL-deleted object's backing file survives (orphan)",
        status: "info",
        detail: "orphan = a re-inserted row with the original version serves the original bytes",
        measurements: mc,
      });

      // ---------------- SS01d ----------------
      const ml: Record<string, number | string> = {};
      const base: number[] = [];
      for (let i = 0; i < 15; i++) base.push((await rest(proj, "GET", "/version")).ms);
      ml.rtt_baseline_get_version_median_ms = r1(median(base));
      const seed = async (prefix: string, n: number) => {
        await c.query(
          "insert into storage.objects (bucket_id, name, metadata, version) select $1, $2 || 'o-' || lpad(i::text, 6, '0') || '.txt', jsonb_build_object('size', 10, 'mimetype', 'text/plain', 'eTag', '\"x\"', 'cacheControl', 'no-cache', 'contentLength', 10, 'httpStatusCode', 200), gen_random_uuid()::text from generate_series(1, $3::int) i",
          [BUCKET, prefix, n],
        );
      };
      // [prefix, rows, also walk the whole prefix with v1 (250+ sequential requests)]
      const sizes: Array<[string, number, boolean]> = [
        ["deep5k/", 5000, true],
        ["deep25k/", 25000, true],
        ["deep100k/", 100000, false],
      ];
      for (const [prefix, n] of sizes) await seed(prefix, n);
      await c.query("analyze storage.objects");
      ml.rows_seeded = sizes.map(([, n]) => n).join("+");

      const v1 = (prefix: string, offset: number, limit = 100) =>
        rest(proj, "POST", `/object/list/${BUCKET}`, { prefix, limit, offset, sortBy: { column: "name", order: "asc" } });
      const v2 = (prefix: string, cursor?: string, limit = 100) =>
        rest(proj, "POST", `/object/list-v2/${BUCKET}`, { prefix, limit, ...(cursor ? { cursor } : {}), with_delimiter: true, sortBy: { column: "name", order: "asc" } });
      const names1 = (t: string) => (JSON.parse(t) as Array<{ name: string }>).map((x) => x.name);
      const probeV2 = await v2("deep5k/");
      ml.v2_endpoint_status = probeV2.status;
      let v2ok = probeV2.status === 200;

      for (const [prefix, n, walkV1] of sizes) {
        const tag = prefix.replace("/", "");
        const pages = n / 100;
        // depth sweep for v1
        const offsets = [0, Math.floor(n / 5), Math.floor(n / 2), n - 100];
        for (const off of offsets) {
          const xs: number[] = [];
          for (let i = 0; i < 7; i++) {
            const r = await v1(prefix, off);
            if (r.status !== 200) {
              ml[`${tag}_v1_off${off}_err`] = `${r.status} ${short(r.text, 80)}`;
              break;
            }
            xs.push(r.ms);
          }
          ml[`${tag}_v1_off${off}_median_ms`] = r1(median(xs));
        }
        if (!v2ok) continue;
        // walk v2, saving the cursor that leads to each page
        const cursors: Array<string | undefined> = [undefined];
        const walkMs: number[] = [];
        const seenV2: string[] = [];
        let cur: string | undefined;
        const wt = performance.now();
        for (let i = 0; i < pages + 2; i++) {
          const r = await v2(prefix, cur);
          if (r.status !== 200) {
            ml[`${tag}_v2_walk_err`] = `${r.status} ${short(r.text, 80)}`;
            break;
          }
          walkMs.push(r.ms);
          const j = JSON.parse(r.text) as { hasNext: boolean; nextCursor?: string; objects: Array<{ name: string }> };
          for (const o of j.objects) seenV2.push(o.name.split("/").pop()!); // v1 returns names relative to the prefix, v2 full keys
          if (!j.hasNext || !j.nextCursor) break;
          cur = j.nextCursor;
          cursors.push(cur);
        }
        const walkTotal = performance.now() - wt;
        ml[`${tag}_v2_walk_pages`] = walkMs.length;
        ml[`${tag}_v2_walk_objects`] = seenV2.length;
        ml[`${tag}_v2_walk_total_ms`] = Math.round(walkTotal);
        ml[`${tag}_v2_walk_page_median_ms`] = r1(median(walkMs));
        ml[`${tag}_v2_walk_page_p95_ms`] = r1(pct(walkMs, 95));
        ml[`${tag}_v2_walk_first_page_ms`] = r1(walkMs[0] ?? NaN);
        ml[`${tag}_v2_walk_last_page_ms`] = r1(walkMs.at(-1) ?? NaN);
        // deep page for v2: re-request the cursor that leads to a given page
        for (const idx of [Math.floor(cursors.length / 5), Math.floor(cursors.length / 2), cursors.length - 1]) {
          const xs: number[] = [];
          for (let i = 0; i < 7; i++) {
            const r = await v2(prefix, cursors[idx]);
            if (r.status !== 200) break;
            xs.push(r.ms);
          }
          ml[`${tag}_v2_page${idx}_median_ms`] = r1(median(xs));
        }
        // walk v1 over the same prefix
        const seenV1: string[] = [];
        const v1ms: number[] = [];
        const wt1 = performance.now();
        for (let off = 0; walkV1 && off < n; off += 100) {
          const r = await v1(prefix, off);
          if (r.status !== 200) {
            ml[`${tag}_v1_walk_err`] = `${r.status} ${short(r.text, 80)}`;
            break;
          }
          v1ms.push(r.ms);
          seenV1.push(...names1(r.text));
        }
        if (walkV1) {
          ml[`${tag}_v1_walk_pages`] = v1ms.length;
          ml[`${tag}_v1_walk_total_ms`] = Math.round(performance.now() - wt1);
          ml[`${tag}_v1_walk_page_median_ms`] = r1(median(v1ms));
          ml[`${tag}_v1_walk_page_p95_ms`] = r1(pct(v1ms, 95));
          ml[`${tag}_v1_walk_first_page_ms`] = r1(v1ms[0] ?? NaN);
          ml[`${tag}_v1_walk_last_page_ms`] = r1(v1ms.at(-1) ?? NaN);
          ml[`${tag}_walks_return_same_names`] = seenV1.length === seenV2.length && seenV1.every((x, i) => x === seenV2[i]) ? "yes" : "no";
        }

        // DB-side time of the two storage functions at the last page (no network)
        const dbMs = async (sqlText: string) => {
          const xs: number[] = [];
          const notes: string[] = [];
          const onN = (msg: { message?: string }) => notes.push(msg.message ?? "");
          c.on("notice", onN);
          for (let i = 0; i < 5; i++) {
            await c.query(sqlText);
          }
          c.off("notice", onN);
          for (const x of notes) xs.push(Number(x));
          return r1(median(xs.filter((x) => Number.isFinite(x))));
        };
        const lastName = `${prefix}o-${String(n - 100).padStart(6, "0")}.txt`;
        ml[`${tag}_db_search_v1_lastpage_median_ms`] = await dbMs(
          `do $$ declare t timestamptz := clock_timestamp(); begin perform * from storage.search('${prefix}', '${BUCKET}', 100, 1, ${n - 100}, '', 'name', 'asc'); raise notice '%', extract(epoch from clock_timestamp() - t) * 1000; end $$`,
        );
        ml[`${tag}_db_search_v2_lastpage_median_ms`] = await dbMs(
          `do $$ declare t timestamptz := clock_timestamp(); begin perform * from storage.search_v2('${prefix}', '${BUCKET}', 100, 1, '${lastName}', 'asc', 'name', ''); raise notice '%', extract(epoch from clock_timestamp() - t) * 1000; end $$`,
        );
      }
      out.push({
        id: "SS01d",
        title: "SS01d: list v1 (offset) vs v2 (cursor), 100 per page",
        status: v2ok ? "info" : "fail",
        detail: v2ok ? "latencies, no pass band; client is a laptop to ap-southeast-1" : `list-v2 answered ${probeV2.status}`,
        measurements: ml,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) if (!out.some((r) => r.id === id)) out.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
    } finally {
      await pgc?.end().catch(() => null);
      if (ref) {
        const s = await teardown(ctx, ref).catch(() => -1);
        ctx.log(`SS01 teardown DELETE -> ${s}`);
      }
    }
    for (const id of ids) if (!out.some((r) => r.id === id)) out.push({ id, title: id, status: "skip", detail: "row never produced" });
    return out;
  },
};
export default mod;
