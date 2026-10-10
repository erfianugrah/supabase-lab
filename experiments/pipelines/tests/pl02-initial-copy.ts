/**
 * PL02 - initial copy, on the open-source replicator against a Supabase Pro
 * project (eu-central-1, Micro compute), DuckLake destination on local
 * containers.
 *
 * Entity note: this measures the open-source engine the managed Pipelines docs
 * say they run, from a laptop in Singapore, not the managed service. The
 * managed service cannot be driven with a PAT (PL01). Copy time here includes
 * the laptop-to-Frankfurt round trip on every source connection, so it is a
 * pessimistic bound for the engine, and not a figure for the managed product.
 *
 *   PL02a  source facts: Postgres version, wal_level, replication settings,
 *          what the engine installs in the source (schema tables, event
 *          trigger, slots) the first time it starts.
 *   PL02b  N-row table seeded server-side, publication created, replicator
 *          started: seconds from `compose up` to the table reaching
 *          `sync_done` and to `ready`; state timeline from the source's own
 *          `etl.replication_state` timestamps; slots seen during the copy;
 *          destination count and checksums against the source.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { beginPipeline, ensureFixture, openDuck, withCleanup } from "../lib/fixture.js";
import { REPLICATOR_TAG, num, slots, sleep, tableStates, waitTablesReady } from "../lib/stack.js";
import { lbl, pct, round } from "../lib/util.js";

const mod: TestModule = {
  id: "PL02",
  title: "PL02 - initial copy",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const N = Number(process.env.PL_COPY_ROWS ?? 1_000_000);
    const fx = await ensureFixture(ctx);
    const { db, state } = fx;

    // ---- PL02a: source facts (before the engine has installed anything)
    const pre = await db.q(
      `select version() as v, current_setting('wal_level') as wal_level,
              current_setting('max_replication_slots') as max_slots,
              current_setting('max_wal_senders') as max_senders,
              current_setting('max_slot_wal_keep_size') as max_slot_wal_keep_size,
              current_setting('wal_keep_size') as wal_keep_size,
              current_setting('checkpoint_timeout') as checkpoint_timeout,
              (select count(*) from pg_replication_slots) as slots_before,
              (select rolbypassrls::text from pg_roles where rolname = 'postgres') as postgres_bypassrls`,
    );
    const p = pre[0] ?? {};
    const etlBefore = await db.scalar("select count(*) from information_schema.schemata where schema_name = 'etl'");
    // laptop-to-source round trip: the latency every source connection of the replicator pays
    const rtts: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      await db.q("select 1");
      rtts.push(performance.now() - t);
    }
    results.push({
      id: "PL02a",
      title: "PL02a: source database facts",
      status: "info",
      detail: `project ${fx.created ? "created this run" : "reused from an earlier run"}`,
      measurements: {
        postgres: lbl(p.v ?? "", 60),
        wal_level: p.wal_level ?? "",
        max_replication_slots: p.max_slots ?? "",
        max_wal_senders: p.max_senders ?? "",
        max_slot_wal_keep_size: p.max_slot_wal_keep_size ?? "",
        wal_keep_size: p.wal_keep_size ?? "",
        checkpoint_timeout: p.checkpoint_timeout ?? "",
        slots_before_pipeline: p.slots_before ?? "",
        postgres_role_bypassrls: p.postgres_bypassrls ?? "",
        etl_schema_before: etlBefore,
        create_status: state.createStatus ?? "reused",
        ipv4_addon_dns_s: state.ipv4Seconds ?? "reused",
        replicator_commit: REPLICATOR_TAG.slice(0, 12),
        laptop_to_source_select1_p50_ms: round(pct(rtts, 50)),
        laptop_to_source_select1_max_ms: round(Math.max(...rtts)),
      },
    });

    // ---- PL02b: seed and copy
    await db.q("drop table if exists public.pl02_copy cascade");
    await db.q(
      `create table public.pl02_copy (id bigint primary key, name text not null, qty int, note text, created_at timestamptz default now())`,
    );
    const ts0 = Date.now();
    await db.q(
      `insert into public.pl02_copy select g, 'name-' || g, g % 1000, md5(g::text), now() from generate_series(1, ${N}) g`,
    );
    const seedMs = Date.now() - ts0;
    await db.q("analyze public.pl02_copy");
    const srcAgg = (
      await db.q("select count(*) c, sum(id) s, sum(qty) q, sum(length(note)) l from public.pl02_copy")
    )[0] ?? {};
    const heapBytes = num(await db.scalar("select pg_relation_size('public.pl02_copy')"));
    const totalBytes = num(await db.scalar("select pg_total_relation_size('public.pl02_copy')"));

    const t0 = await beginPipeline(fx, { tables: ["public.pl02_copy"], tag: "pl02" });
    // Watch the slots while copying: the engine documents one main slot plus one
    // temporary slot per active table-sync worker.
    let maxSlots = 0;
    let slotNames = new Set<string>();
    const watch = (async () => {
      for (;;) {
        const st = await tableStates(db, ["public.pl02_copy"]).catch(() => ({}) as Record<string, string>);
        const s = await slots(db).catch(() => []);
        maxSlots = Math.max(maxSlots, s.length);
        for (const r of s) slotNames.add(r.slot_name.replace(/_\d+(_\d+)?$/, "_<id>"));
        const cur = st["public.pl02_copy"];
        if (cur === "sync_done" || cur === "ready" || cur === "errored") return;
        await sleep(1500);
      }
    })();
    const w = await waitTablesReady(db, ["public.pl02_copy"], 1_800_000, 2000, ["sync_done", "ready"]);
    await watch;
    const syncDoneWallMs = Date.now() - t0;

    // state timeline from the source's own clock
    const hist = await db.q(
      `select state::text as s, extract(epoch from created_at)::float8 as e
         from etl.replication_state where table_id = 'public.pl02_copy'::regclass::oid order by id`,
    );
    const at = (s: string) => {
      const r = hist.find((h) => h.s === s);
      return r ? Number(r.e) : NaN;
    };
    const copyDbMs = (at("finished_copy") - at("data_sync")) * 1000;
    const catchupDbMs = (at("sync_done") - at("finished_copy")) * 1000;

    // destination check, through the catalog
    const duck = await openDuck();
    let dst: string[] = [];
    try {
      const t1 = Date.now();
      let n = "";
      // the apply worker may still be flushing; allow a short settle
      for (let i = 0; i < 12; i++) {
        n = await duck.scalar("select count(*) from lake.public.pl02_copy");
        if (n === srcAgg.c) break;
        await sleep(2500);
      }
      dst = (
        await duck.rows(
          "select count(*), sum(id), sum(qty), sum(length(note)) from lake.public.pl02_copy",
        )
      )[0] ?? [];
      void t1;
    } finally {
      duck.close();
    }
    const match =
      dst[0] === srcAgg.c && dst[1] === srcAgg.s && dst[2] === srcAgg.q && dst[3] === srcAgg.l;

    // how long until `ready` (promoted by the first WAL activity after sync_done)
    await db.q("update public.pl02_copy set qty = qty where id = 1");
    const r = await waitTablesReady(db, ["public.pl02_copy"], 120_000, 1500);

    results.push({
      id: "PL02b",
      title: `PL02b: initial copy of ${N} rows`,
      status: w.ok && match ? "pass" : "fail",
      detail: `table state ${JSON.stringify(w.states)}; destination ${match ? "matches" : "DIFFERS from"} source (count/sum(id)/sum(qty)/sum(length(note)))`,
      measurements: {
        rows: N,
        heap_mb: round(heapBytes / 1e6, 1),
        total_relation_mb: round(totalBytes / 1e6, 1),
        seed_s: round(seedMs / 1000, 1),
        up_to_sync_done_s: round(syncDoneWallMs / 1000, 1),
        copy_phase_s: round(copyDbMs / 1000, 1),
        catchup_phase_s: round(catchupDbMs / 1000, 1),
        copy_mb_per_s: round(heapBytes / 1e6 / (copyDbMs / 1000), 2),
        sync_done_to_ready_s: r.ok ? round(r.ms / 1000, 1) : -1,
        state_timeline: lbl(hist.map((h) => h.s).join(">")),
        max_slots_during_copy: maxSlots,
        slot_names_seen: lbl([...slotNames].join(" ")),
        dest_rows: dst[0] ?? "",
        src_rows: srcAgg.c ?? "",
        dest_matches_source: match ? "yes" : "no",
      },
    });
    slotNames = new Set();
    return results;
  },
};

export default withCleanup(mod);
