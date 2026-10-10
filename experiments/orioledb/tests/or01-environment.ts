/**
 * OR01 - what the pair is, and what the hosted role can and cannot do on it.
 *
 * Creates the pair (lib/pair.ts: one OrioleDB project created with
 * `postgres_engine: "17-oriole"`, one heap control, same region and compute
 * size) and reads, per project:
 *
 *   OR01a  the create-body field. The published OpenAPI document types
 *          `postgres_engine` on `POST /v1/projects` as deprecated `null`; this
 *          records what the project reports back (`GET /v1/projects/{ref}`
 *          `database.postgres_engine`, `release_channel`) so the field's
 *          effect is measured, not read from the spec.
 *   OR01b  server identity per project: `version()` (Postgres build and
 *          architecture), default table access method, shared_buffers, the
 *          orioledb.* pool settings, installed extensions, wal_level, whether
 *          the hosted `postgres` role is a superuser, holds `pg_checkpoint`,
 *          has `rolreplication`, and whether `xmin` is readable on a table of
 *          each access method.
 *   OR01c  `GET /v1/organizations/{slug}/entitlements` for the `instances.orioledb`,
 *          `pitr.available_variants` and `replication.etl` keys on each org
 *          supplied (`PVLAB_ORG_PRO`, `PVLAB_ORG_TEAM`, `PVLAB_ORG_FREE`).
 *          Read-only. Whether a Free org can actually create the project is
 *          not exercised here.
 *   OR01d  the heap control cannot host an OrioleDB table: `CREATE TABLE ...
 *          USING orioledb` and `CREATE EXTENSION orioledb` on it.
 *
 * Not settled by this module: anything about a compute size other than the
 * one in OR_SIZE (default small), or a region other than OR_REGION.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { ensureExtra, ensurePair, skipWithoutOrg, REGION, SIZE, tryQuery, withConn, type Proj } from "../lib/pair";

const ID = "OR01";

const SETTINGS = [
  "server_version",
  "default_table_access_method",
  "shared_buffers",
  "max_connections",
  "wal_level",
  "max_wal_size",
  "checkpoint_timeout",
  "full_page_writes",
  "wal_compression",
  "data_checksums",
  "max_replication_slots",
  "max_wal_senders",
  "autovacuum",
  "autovacuum_naptime",
  "shared_preload_libraries",
];

async function serverFacts(p: Proj): Promise<Record<string, string | number>> {
  return withConn(p, async (c) => {
    const m: Record<string, string | number> = {};
    m.version = String((await c.query("select version() as v")).rows[0].v);
    const arch = /on ([a-z0-9_]+)-/.exec(m.version);
    m.arch = arch?.[1] ?? "?";
    for (const s of SETTINGS) m[s] = String((await c.query("select current_setting($1, true) as v", [s])).rows[0]?.v ?? "(absent)");
    const role = (
      await c.query(
        `select rolsuper::text as su, rolreplication::text as repl,
                pg_has_role(current_user, 'pg_checkpoint', 'member')::text as ckpt
           from pg_roles where rolname = current_user`,
      )
    ).rows[0];
    m.role_superuser = role.su;
    m.role_replication = role.repl;
    m.role_pg_checkpoint = role.ckpt;
    const ck = await tryQuery(c, "checkpoint");
    m.checkpoint_statement = ck.ok ? "allowed" : ck.error;
    m.extensions = (await c.query("select string_agg(extname || ' ' || extversion, ', ' order by extname) as e from pg_extension")).rows[0].e;
    m.am_list = (await c.query("select string_agg(amname, ',' order by amname) as a from pg_am where amtype = 't'")).rows[0].a;
    const ob = await c.query("select name, setting from pg_settings where name like 'orioledb.%' and name in ('orioledb.main_buffers','orioledb.undo_buffers','orioledb.xid_buffers','orioledb.free_tree_buffers','orioledb.catalog_buffers','orioledb.recovery_pool_size','orioledb.recovery_idx_pool_size','orioledb.bgwriter_num_workers','orioledb.default_compress','orioledb.serializable')");
    for (const r of ob.rows) m[String(r.name)] = String(r.setting);
    const ov = await tryQuery(c, "select orioledb_version() as v");
    m.orioledb_version = ov.ok ? String(ov.rows[0]?.v) : "(function absent)";
    // xmin readability per access method, on throwaway tables.
    await c.query("drop table if exists public.or01_h, public.or01_o");
    await c.query("create table public.or01_h (id bigint primary key) using heap");
    await c.query("insert into public.or01_h values (1)");
    const hx = await tryQuery(c, "select xmin::text from public.or01_h");
    m.xmin_on_heap_table = hx.ok ? "readable" : hx.error;
    const mk = await tryQuery(c, "create table public.or01_o (id bigint primary key) using orioledb");
    if (mk.ok) {
      await c.query("insert into public.or01_o values (1)");
      const ox = await tryQuery(c, "select xmin::text from public.or01_o");
      m.xmin_on_orioledb_table = ox.ok ? "readable" : ox.error;
      const oc = await tryQuery(c, "select ctid::text from public.or01_o");
      m.ctid_on_orioledb_table = oc.ok ? "readable" : oc.error;
    } else {
      m.xmin_on_orioledb_table = `no orioledb table: ${mk.error}`;
    }
    await c.query("drop table if exists public.or01_h, public.or01_o");
    return m;
  });
}

const mod: TestModule = {
  id: ID,
  title: "Pair creation, engine field, server identity, hosted-role privileges, org entitlements",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title);
    if (skipped) return skipped;
    const out: TestResult[] = [];
    const pair = await ensurePair(ctx);
    // Start the extra OrioleDB projects now (OR06-OR08 use them) so they are
    // healthy by the time those modules run; a failure surfaces there.
    if (!process.env.OR_NO_EXTRAS) for (const l of ["scratch", "conva", "convb"]) void ensureExtra(ctx, l).catch(() => undefined);

    // OR01a - what the create body's postgres_engine did.
    const eng: Record<string, string | number> = { region_requested: REGION, size_requested: SIZE };
    for (const p of [pair.oriole, pair.heap]) {
      const g = await mgmt(ctx, "GET", `/projects/${p.ref}`);
      const db = ((g.json as { database?: Record<string, unknown> } | undefined)?.database ?? {}) as Record<string, unknown>;
      eng[`${p.role}_postgres_engine`] = String(db.postgres_engine ?? "(absent)");
      eng[`${p.role}_release_channel`] = String(db.release_channel ?? "(absent)");
      eng[`${p.role}_database_version`] = String(db.version ?? "(absent)");
      eng[`${p.role}_created_with_postgres_engine_field`] = p.role === "oriole" ? "17-oriole" : "(omitted)";
      const dk = await mgmt(ctx, "GET", `/projects/${p.ref}/config/disk`);
      const da = ((dk.json ?? {}) as { attributes?: { size_gb?: number; type?: string; iops?: number; throughput_mibps?: number } }).attributes ?? {};
      eng[`${p.role}_disk_size_gb`] = da.size_gb ?? -1;
      eng[`${p.role}_disk_type_iops_mibps`] = `${da.type ?? "?"} ${da.iops ?? "?"} ${da.throughput_mibps ?? "?"}`;
      const listing = ctx.orgs.pro ? await mgmt(ctx, "GET", `/organizations/${ctx.orgs.pro}/projects`) : undefined;
      const rows = ((listing?.json as { projects?: Array<Record<string, unknown>> } | undefined)?.projects ?? []) as Array<{
        ref?: string;
        databases?: Array<{ infra_compute_size?: string }>;
      }>;
      eng[`${p.role}_infra_compute_size`] = rows.find((r) => r.ref === p.ref)?.databases?.[0]?.infra_compute_size ?? "(not in listing)";
    }
    out.push({
      id: `${ID}a`,
      title: "OR01a: create-body postgres_engine reads back as 17-oriole",
      status: eng.oriole_postgres_engine === "17-oriole" && eng.heap_postgres_engine !== "17-oriole" ? "pass" : "fail",
      detail: `oriole=${eng.oriole_postgres_engine}/${eng.oriole_release_channel} heap=${eng.heap_postgres_engine}/${eng.heap_release_channel}`,
      measurements: eng,
    });

    // OR01b - server identity and hosted-role privileges.
    for (const p of [pair.oriole, pair.heap]) {
      const f = await serverFacts(p);
      out.push({
        id: `${ID}b-${p.role}`,
        title: `OR01b: server identity and privileges (${p.role} project)`,
        status: "info",
        detail: String(f.version),
        measurements: { project: p.role, ...f },
      });
    }

    // OR01c - entitlements per org supplied.
    const ent: Record<string, string | number> = {};
    for (const [role, slug] of Object.entries(ctx.orgs)) {
      const r = await mgmt(ctx, "GET", `/organizations/${slug}/entitlements`);
      const list = ((r.json as { entitlements?: Array<{ feature?: { key?: string }; hasAccess?: boolean; config?: { set?: string[] } }> } | undefined)?.entitlements ?? []);
      for (const key of ["instances.orioledb", "pitr.available_variants", "replication.etl", "instances.read_replicas"]) {
        const e = list.find((x) => x.feature?.key === key);
        ent[`${role}_org_${key}`] = e ? (e.config?.set ? `hasAccess=${e.hasAccess} set=${e.config.set.join("|") || "(empty)"}` : `hasAccess=${e.hasAccess}`) : `(key absent, HTTP ${r.status})`;
      }
    }
    out.push({
      id: `${ID}c`,
      title: "OR01c: org entitlements for OrioleDB, PITR and replication ETL",
      status: Object.keys(ent).length ? "info" : "skip",
      detail: Object.keys(ent).length ? undefined : "no PVLAB_ORG_* supplied",
      measurements: ent,
    });

    // OR01d - the heap control cannot host an OrioleDB table.
    const d = await withConn(pair.heap, async (c) => {
      const ext = await tryQuery(c, "create extension orioledb");
      const tbl = await tryQuery(c, "create table public.or01_x (id bigint primary key) using orioledb");
      await tryQuery(c, "drop table if exists public.or01_x");
      const avail = await tryQuery(c, "select count(*)::int as n from pg_available_extensions where name = 'orioledb'");
      return { ext, tbl, avail };
    });
    out.push({
      id: `${ID}d`,
      title: "OR01d: OrioleDB table on the heap control project",
      status: "info",
      detail: d.tbl.ok ? "table created" : d.tbl.error,
      measurements: {
        create_extension: d.ext.ok ? "ok" : d.ext.error,
        create_table_using_orioledb: d.tbl.ok ? "ok" : d.tbl.error,
        orioledb_in_pg_available_extensions: String(d.avail.rows[0]?.n ?? "?"),
      },
    });
    return out;
  },
};

export default mod;
