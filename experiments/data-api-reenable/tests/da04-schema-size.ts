/**
 * DA04 - does recovery scale with the size of the schema?
 *
 * On enable PostgREST has to load its schema cache before it serves, and the
 * load reads every table, column, function and relationship in the exposed
 * schemas. A lab project with one table loads in milliseconds; a production
 * schema may not. This bulks `public` up to PVLAB_DA_TABLES tables (default
 * 3000, each with a foreign key so relationship detection has work to do),
 * times a plain schema reload as the reference, then an off/on cycle.
 *
 * DESTRUCTIVE: switches the Data API off; drops the bulk tables afterwards.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, sql } from "../../../harness/src/platform.js";
import { APP_PATHS, dataApiProbes, fmtTransitions, getPostgrest, setSchemas, timeline } from "../lib/reenable.js";

const PREFIX = "da_bulk_";
const BATCH = 500;

const mod: TestModule = {
  id: "DA04",
  title: "Re-enable recovery with a large schema",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const n = Number(process.env.PVLAB_DA_TABLES ?? 3000);
    const keys = await fetchKeys(ctx);
    const probes = dataApiProbes(ctx, keys);
    const base = await getPostgrest(ctx);
    const out: TestResult[] = [];
    // Batched: one DO block over thousands of tables can outlive the query
    // endpoint's timeout on Micro.
    const eachBatch = async (stmt: string) => {
      for (let i = 0; i < n; i += BATCH) {
        const r = await sql(
          ctx,
          `do $$ begin for i in ${i}..${Math.min(i + BATCH - 1, n - 1)} loop execute format('${stmt}', i); end loop; end $$`,
          120_000,
        );
        if (r.status >= 300) throw new Error(`batch at ${i}: ${r.error}`);
      }
    };

    try {
      await sql(ctx, `create table if not exists public.${PREFIX}root (id int primary key)`);
      await eachBatch(
        `create table if not exists public.${PREFIX}%s (id int primary key, root_id int references public.${PREFIX}root(id), a text, b int, c timestamptz)`,
      );
      const count = await sql(ctx, `select count(*)::int as n from pg_tables where schemaname = 'public'`);

      // Reference: a schema reload with the API on. Times a NEW table becoming
      // visible, which is the schema-cache load; the old cache keeps serving.
      const marker = `${PREFIX}marker`;
      const reload = await timeline(
        [
          {
            name: "marker_table",
            intervalMs: 250,
            run: async () => {
              const r = await fetch(`https://${ctx.apiHost}/rest/v1/${marker}?select=id`, {
                headers: { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` },
              });
              await r.text();
              return { ok: r.status === 200, state: String(r.status) };
            },
          },
        ],
        { maxWaitMs: 300_000, settleMs: 2_000, stopOn: ["marker_table"], log: ctx.log },
        async () => {
          await sql(ctx, `create table if not exists public.${marker} (id int)`);
          await sql(ctx, `grant select on public.${marker} to anon`);
          await sql(ctx, `notify pgrst, 'reload schema'`);
        },
      );

      await setSchemas(ctx, base, "");
      const t1 = Date.now();
      while (Date.now() - t1 < 60_000 && (await probes[0]!.run()).ok) await Bun.sleep(500);
      await Bun.sleep(30_000);

      const on = await timeline(
        probes,
        { maxWaitMs: 600_000, settleMs: 10_000, stopOn: APP_PATHS, log: ctx.log },
        async () => {
          await setSchemas(ctx, base, base.db_schema);
        },
      );
      const m: Record<string, number | string> = {
        public_tables: Number(count.rows[0]?.n ?? -1),
        reload_marker_visible_ms: reload.paths[0]?.firstOkMs ?? "never",
      };
      for (const p of on.paths) {
        m[`${p.name}_first_ok_ms`] = p.firstOkMs ?? "never";
        m[`${p.name}_sustained_ms`] = p.sustainedOkMs ?? "never";
      }
      out.push({
        id: "DA04",
        title: this.title,
        status: "info",
        detail: `${m.public_tables} tables in public; reload ${m.reload_marker_visible_ms} ms; after enable rest_table sustained-ok at ${m.rest_table_sustained_ms} ms`,
        measurements: m,
        evidence: [...reload.paths.map(fmtTransitions), ...on.paths.map(fmtTransitions)].join("\n"),
      });
    } finally {
      const back = await setSchemas(ctx, base, base.db_schema);
      await eachBatch(`drop table if exists public.${PREFIX}%s`).catch(() => undefined);
      await sql(ctx, `drop table if exists public.${PREFIX}marker`);
      await sql(ctx, `drop table if exists public.${PREFIX}root`);
      await sql(ctx, `notify pgrst, 'reload schema'`);
      out.push({
        id: "DA04z",
        title: "restore PostgREST config, drop bulk tables",
        status: back.status === 200 ? "pass" : "fail",
        detail: back.status === 200 ? "restored" : `restore HTTP ${back.status}`,
      });
    }
    return out;
  },
};
export default mod;
