/**
 * C04 - the data half: two schemas whose keys were both allocated from 1.
 *
 * Every source project ran its own sequences, so both customers own an order
 * 1, an order 2 and an order 3. Splitting a shared project never produces
 * this; merging two independent ones always does, for every surrogate key in
 * the schema.
 *
 * Three ways out, and the choice is not a matter of taste - it decides whether
 * the customer's existing identifiers (order numbers on invoices, URLs, ids
 * quoted in support tickets) survive the consolidation:
 *
 *   - keep the id, scope the key: primary key (tenant_id, id). Ids survive.
 *   - reassign the id and keep the old one in a column. External references
 *     break unless every consumer is updated.
 *   - never have the problem: uuid keys, which is why the control here is a
 *     uuid-keyed table merged the same way.
 *
 * The last check is the one that gets skipped: after preserving ids, the
 * merged table's own sequence still starts at 1, so the first row written
 * AFTER the merge collides with a row that came in during it. The failure
 * surfaces on the first real write, not during the migration.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sql, sqlstate, waitReady } from "../lib/consolidate";

const SOURCE_SCHEMA = `
create table if not exists public.orders (
  id bigserial primary key,
  sku text not null,
  placed_at timestamptz not null default now());
create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  label text not null);
-- restart identity, or a second run seeds ids 4..6 and C04a's assertion on
-- "both sources allocated 1..3" turns into a false negative while the
-- collision it exists to explain still reproduces.
truncate public.orders restart identity;
truncate public.carts restart identity;
`;

const mod: TestModule = {
  id: "C04",
  title: "Merging two schemas whose surrogate keys both start at 1",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const srcA = ctx.peers.src_a;
    const srcB = ctx.peers.src_b;
    const shared = ctx.ref;
    if (!srcA || !srcB) {
      return { id: "C04", title: this.title, status: "skip", detail: "needs both source refs" };
    }
    const results: TestResult[] = [];
    await waitReady(ctx, shared);

    for (const [ref, prefix] of [
      [srcA, "a"],
      [srcB, "b"],
    ] as const) {
      await sql(ctx, ref, SOURCE_SCHEMA);
      await sql(
        ctx,
        ref,
        `insert into public.orders(sku) values ('${prefix}-1'),('${prefix}-2'),('${prefix}-3');
         insert into public.carts(label) values ('${prefix}-cart-1'),('${prefix}-cart-2');`,
      );
    }
    const overlap = await sql(
      ctx,
      srcA,
      `select array_agg(id order by id)::text as ids from public.orders`,
    );
    results.push({
      id: "C04a",
      title: "Both sources allocated the same ids",
      status: String(overlap.rows?.[0]?.ids ?? "") === "{1,2,3}" ? "pass" : "info",
      detail: `source A orders ids = ${String(overlap.rows?.[0]?.ids ?? "?")}, source B identical`,
      measurements: { ids: String(overlap.rows?.[0]?.ids ?? "?") },
    });

    // Target 1: the obvious schema - keep the id as the primary key, add a
    // tenant column.
    await sql(
      ctx,
      shared,
      `drop table if exists public.orders_naive;
       create table public.orders_naive (
         id bigint primary key, tenant_id text not null, sku text not null,
         placed_at timestamptz not null default now());`,
    );
    // The generic copyTable helper lands a table into the SAME name on the
    // target; here the target names differ per variant, so each load is an
    // explicit statement.
    const loadNaive = async (from: string, tenant: string) => {
      const dump = await sql(
        ctx,
        from,
        `select coalesce(json_agg(t),'[]'::json)::text as payload from (select id, sku from public.orders) t`,
      );
      const payload = String(dump.rows?.[0]?.payload ?? "[]");
      return sql(
        ctx,
        shared,
        `insert into public.orders_naive(id, tenant_id, sku)
           select (e->>'id')::bigint, '${tenant}', e->>'sku'
             from json_array_elements($p$${payload}$p$::json) e`,
      );
    };
    const nA = await loadNaive(srcA, "tenant-a");
    const nB = await loadNaive(srcB, "tenant-b");
    const naiveCount = await sql(ctx, shared, `select count(*)::int as n from public.orders_naive`);
    results.push({
      id: "C04b",
      title: "Keeping id as the primary key: the second customer is refused",
      status: nA.status < 300 && nB.status >= 400 ? "pass" : "fail",
      detail:
        nB.status >= 400
          ? `A ok, B refused: ${sqlstate(nB)} ${nB.error?.slice(0, 120)}`
          : `B was ACCEPTED (HTTP ${nB.status}) - the ids did not collide, check the fixture`,
      measurements: {
        a_status: nA.status,
        b_status: nB.status,
        sqlstate: sqlstate(nB),
        rows: Number(naiveCount.rows?.[0]?.n ?? -1),
      },
      evidence: nB.error?.slice(0, 300),
    });

    // Target 2: scope the key to the tenant. Ids are preserved on both sides.
    await sql(
      ctx,
      shared,
      `drop table if exists public.orders_scoped;
       create table public.orders_scoped (
         tenant_id text not null, id bigint not null, sku text not null,
         primary key (tenant_id, id));`,
    );
    const loadScoped = async (from: string, tenant: string) => {
      const dump = await sql(
        ctx,
        from,
        `select coalesce(json_agg(t),'[]'::json)::text as payload from (select id, sku from public.orders) t`,
      );
      const payload = String(dump.rows?.[0]?.payload ?? "[]");
      return sql(
        ctx,
        shared,
        `insert into public.orders_scoped(tenant_id, id, sku)
           select '${tenant}', (e->>'id')::bigint, e->>'sku'
             from json_array_elements($p$${payload}$p$::json) e`,
      );
    };
    const sA = await loadScoped(srcA, "tenant-a");
    const sB = await loadScoped(srcB, "tenant-b");
    const scoped = await sql(
      ctx,
      shared,
      `select count(*)::int as n, count(distinct id)::int as distinct_ids from public.orders_scoped`,
    );
    results.push({
      id: "C04c",
      title: "Scoping the key to the tenant admits both, with ids intact",
      status:
        sA.status < 300 && sB.status < 300 && Number(scoped.rows?.[0]?.n ?? 0) === 6 ? "pass" : "fail",
      detail: `${String(scoped.rows?.[0]?.n ?? "?")} rows over ${String(scoped.rows?.[0]?.distinct_ids ?? "?")} distinct ids - each customer keeps 1..3`,
      measurements: {
        rows: Number(scoped.rows?.[0]?.n ?? -1),
        distinct_ids: Number(scoped.rows?.[0]?.distinct_ids ?? -1),
      },
    });

    // Control: a uuid-keyed table merges with no special handling at all, which
    // is what makes C04b a property of key ALLOCATION rather than of merging.
    await sql(
      ctx,
      shared,
      `drop table if exists public.carts_merged;
       create table public.carts_merged (
         id uuid primary key, tenant_id text not null, label text not null);`,
    );
    const loadCarts = async (from: string, tenant: string) => {
      const dump = await sql(
        ctx,
        from,
        `select coalesce(json_agg(t),'[]'::json)::text as payload from (select id::text, label from public.carts) t`,
      );
      const payload = String(dump.rows?.[0]?.payload ?? "[]");
      return sql(
        ctx,
        shared,
        `insert into public.carts_merged(id, tenant_id, label)
           select (e->>'id')::uuid, '${tenant}', e->>'label'
             from json_array_elements($p$${payload}$p$::json) e`,
      );
    };
    const cA = await loadCarts(srcA, "tenant-a");
    const cB = await loadCarts(srcB, "tenant-b");
    const carts = await sql(ctx, shared, `select count(*)::int as n from public.carts_merged`);
    results.push({
      id: "C04d",
      title: "Control: uuid keys merge with no collision",
      status: cA.status < 300 && cB.status < 300 && Number(carts.rows?.[0]?.n ?? 0) === 4 ? "pass" : "fail",
      detail: `${String(carts.rows?.[0]?.n ?? "?")} rows from both sources, no key handling needed`,
      measurements: { rows: Number(carts.rows?.[0]?.n ?? -1) },
    });

    // The write AFTER the merge. A fresh sequence on the merged table starts at
    // 1, which is a live id for every tenant that came in.
    await sql(
      ctx,
      shared,
      // Dropped, not `if not exists`: the table is recreated every run but a
      // surviving sequence keeps its value, so on the second run nextval is
      // already past the migrated ids and the collision this test exists to
      // show silently stops reproducing.
      `drop sequence if exists public.orders_scoped_seq cascade;
       create sequence public.orders_scoped_seq;
       alter table public.orders_scoped alter column id set default nextval('public.orders_scoped_seq');`,
    );
    const firstWrite = await sql(
      ctx,
      shared,
      `insert into public.orders_scoped(tenant_id, sku) values ('tenant-a','a-new')`,
    );
    results.push({
      id: "C04e",
      title: "The first write after the merge collides with a migrated id",
      status: firstWrite.status >= 400 ? "pass" : "fail",
      detail:
        firstWrite.status >= 400
          ? `${sqlstate(firstWrite)} ${firstWrite.error?.slice(0, 120)} - the sequence never learned about the copied rows`
          : "the write succeeded; this fixture did not reproduce the sequence gap",
      measurements: { status: firstWrite.status, sqlstate: sqlstate(firstWrite) },
      evidence: firstWrite.error?.slice(0, 250),
    });

    const fix = await sql(
      ctx,
      shared,
      `select setval('public.orders_scoped_seq', (select max(id) from public.orders_scoped), true);`,
    );
    const secondWrite = await sql(
      ctx,
      shared,
      `insert into public.orders_scoped(tenant_id, sku) values ('tenant-a','a-new')`,
    );
    results.push({
      id: "C04f",
      title: "setval past the highest migrated id fixes it",
      status: fix.status < 300 && secondWrite.status < 300 ? "pass" : "fail",
      detail: `post-setval insert HTTP ${secondWrite.status}`,
      measurements: { setval_status: fix.status, insert_status: secondWrite.status },
      evidence: secondWrite.error?.slice(0, 200),
    });

    return results;
  },
};
export default mod;
