/**
 * OR07 - do the features built on logical decoding and on the Data API work
 * for an OrioleDB table? Runs on the extra OrioleDB project (`scratch`), with a
 * heap table in the same project as the control for every probe.
 *
 *   OR07a  logical replication primitives. `CREATE PUBLICATION` for each
 *          table, a `pgoutput` logical slot per publication, the same
 *          INSERT x 3 / UPDATE x 2 / DELETE x 1 sequence on each table, then
 *          `pg_logical_slot_peek_binary_changes` and a count of messages by
 *          type (first byte: I insert, U update, D delete, R relation, B
 *          begin, C commit). Slots and publications are dropped at the end.
 *          This exercises the server side of a subscription; no subscriber is
 *          attached, so what a downstream Postgres subscriber or the
 *          Replication/ETL product does with the stream is not measured.
 *   OR07b  Realtime `postgres_changes`. Both tables are added to the
 *          `supabase_realtime` publication, a WebSocket joins a channel with
 *          one `postgres_changes` filter per table using the legacy anon JWT,
 *          the same INSERT / UPDATE / DELETE sequence runs, and the events
 *          that arrive per table are counted (wait OR_RT_WAIT_S, default 25 s
 *          after the last statement). Subscribe errors are recorded verbatim.
 *   OR07c  Data API. `GET /rest/v1/<table>` with the anon key on both tables
 *          after an explicit `grant select ... to anon` (new public tables
 *          are not exposed by default) and a schema-cache reload, then a
 *          `POST` insert.
 *
 * Not settled: a real subscriber, Replication/ETL pipelines (needs a
 * destination account), Realtime with row level security, Realtime on
 * Broadcast or Presence, or anything at volume.
 */
import type { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys } from "../../../harness/src/platform";
import { ensureExtra, skipWithoutOrg, sleep, tryQuery, withConn } from "../lib/pair";

const ID = "OR07";

const DML = (t: string) => [
  `insert into public.${t} values (1, 'a')`,
  `insert into public.${t} values (2, 'b')`,
  `insert into public.${t} values (3, 'c')`,
  `update public.${t} set v = 'a2' where id = 1`,
  `update public.${t} set v = 'b2' where id = 2`,
  `delete from public.${t} where id = 3`,
];

async function recreate(c: Client): Promise<void> {
  await c.query("drop table if exists public.lr_o, public.lr_h cascade");
  await c.query("create table public.lr_o (id bigint primary key, v text) using orioledb");
  await c.query("create table public.lr_h (id bigint primary key, v text) using heap");
}

interface RtResult {
  joined: string;
  system: string[];
  events: Record<string, number>;
  types: Record<string, string>;
  error: string;
}

async function realtime(ref: string, anon: string, dml: () => Promise<void>, waitS: number): Promise<RtResult> {
  const res: RtResult = { joined: "", system: [], events: {}, types: {}, error: "" };
  const url = `wss://${ref}.supabase.co/realtime/v1/websocket?apikey=${anon}&vsn=1.0.0`;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    let subscribed = false;
    let hb: ReturnType<typeof setInterval> | undefined;
    const done = () => {
      if (hb) clearInterval(hb);
      try {
        ws.close();
      } catch {
        /* closed */
      }
      resolve();
    };
    const giveUp = setTimeout(() => {
      res.error ||= "timeout waiting for subscribe";
      done();
    }, 60_000);
    ws.onerror = (e) => {
      res.error = `websocket error ${(e as { message?: string }).message ?? ""}`.trim();
    };
    ws.onclose = () => {
      clearTimeout(giveUp);
      resolve();
    };
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          topic: "realtime:or07",
          event: "phx_join",
          ref: "1",
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: "" },
              private: false,
              postgres_changes: [
                { event: "*", schema: "public", table: "lr_o" },
                { event: "*", schema: "public", table: "lr_h" },
              ],
            },
            access_token: anon,
          },
        }),
      );
      hb = setInterval(() => ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "hb" })), 20_000);
    };
    ws.onmessage = async (m) => {
      const msg = JSON.parse(String(m.data)) as { event?: string; payload?: Record<string, unknown> };
      if (msg.event === "phx_reply" && (msg.payload as { response?: unknown })?.response !== undefined) {
        res.joined = String((msg.payload as { status?: string }).status ?? "");
      }
      if (msg.event === "system") {
        const p = msg.payload as { message?: string; status?: string };
        res.system.push(`${p.status ?? ""}: ${String(p.message ?? "").slice(0, 200)}`);
        if (!subscribed && /subscribed to postgresql/i.test(String(p.message ?? "")) && p.status === "ok") {
          subscribed = true;
          await dml();
          setTimeout(done, waitS * 1000);
        } else if (!subscribed && p.status === "error") {
          res.error = String(p.message ?? "").slice(0, 300);
          done();
        }
      }
      if (msg.event === "postgres_changes") {
        const d = (msg.payload as { data?: { table?: string; type?: string } }).data;
        const k = `${d?.table ?? "?"}:${d?.type ?? "?"}`;
        res.events[k] = (res.events[k] ?? 0) + 1;
      }
    };
  });
  return res;
}

const mod: TestModule = {
  id: ID,
  title: "Logical decoding, Realtime postgres_changes and the Data API on an OrioleDB table",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title, ["scratch"]);
    if (skipped) return skipped;
    const out: TestResult[] = [];
    const proj = await ensureExtra(ctx, "scratch");

    // OR07a - publications, slots, decoded messages.
    const a: Record<string, string | number> = {};
    await withConn(proj, async (c) => {
      await recreate(c);
      await tryQuery(c, "select pg_drop_replication_slot('or07_o') from pg_replication_slots where slot_name = 'or07_o'");
      await tryQuery(c, "select pg_drop_replication_slot('or07_h') from pg_replication_slots where slot_name = 'or07_h'");
      await tryQuery(c, "drop publication if exists or07_pub_o");
      await tryQuery(c, "drop publication if exists or07_pub_h");
      for (const [k, t] of [["o", "lr_o"], ["h", "lr_h"]] as const) {
        const pub = await tryQuery(c, `create publication or07_pub_${k} for table public.${t}`);
        a[`${t}_create_publication`] = pub.ok ? "ok" : pub.error;
        const slot = await tryQuery(c, `select pg_create_logical_replication_slot('or07_${k}', 'pgoutput')`);
        a[`${t}_create_logical_slot`] = slot.ok ? "ok" : slot.error;
      }
      for (const [k, t] of [["o", "lr_o"], ["h", "lr_h"]] as const) {
        for (const s of DML(t)) {
          const r = await tryQuery(c, s);
          if (!r.ok) a[`${t}_dml_error`] = r.error;
        }
        const peek = await tryQuery(
          c,
          `select chr(get_byte(data, 0)) as t, count(*)::int as n from pg_logical_slot_peek_binary_changes('or07_${k}', null, null, 'proto_version', '1', 'publication_names', 'or07_pub_${k}') group by 1 order by 1`,
        );
        if (!peek.ok) a[`${t}_decode`] = peek.error;
        else {
          a[`${t}_decode`] = "ok";
          for (const r of peek.rows) a[`${t}_msg_${String(r.t)}`] = Number(r.n);
        }
      }
      for (const k of ["o", "h"]) {
        await tryQuery(c, `select pg_drop_replication_slot('or07_${k}')`);
        await tryQuery(c, `drop publication if exists or07_pub_${k}`);
      }
      const left = await tryQuery(c, "select count(*)::int as n from pg_replication_slots where slot_name like 'or07_%'");
      a.slots_left_after_cleanup = left.ok ? Number(left.rows[0]?.n) : left.error;
    });
    out.push({
      id: `${ID}a`,
      title: "OR07a: publication, logical slot and decoded messages, OrioleDB table vs heap table",
      status: "info",
      detail: `OrioleDB table: publication ${a.lr_o_create_publication}, slot ${a.lr_o_create_logical_slot}, decode ${a.lr_o_decode}; heap table: publication ${a.lr_h_create_publication}, slot ${a.lr_h_create_logical_slot}, decode ${a.lr_h_decode}`,
      measurements: a,
    });

    // OR07b / OR07c - Realtime and Data API.
    let keys;
    try {
      keys = await fetchKeys({ ...ctx, ref: proj.ref });
    } catch (e) {
      out.push({ id: `${ID}b`, title: "OR07b: Realtime", status: "skip", detail: `keys: ${(e as Error).message}` });
      return out;
    }
    await withConn(proj, async (c) => {
      await recreate(c);
    });
    const rt: Record<string, string | number> = {};
    const pubAdd = await withConn(proj, async (c) => {
      const r1 = await tryQuery(c, "alter publication supabase_realtime add table public.lr_h");
      const r2 = await tryQuery(c, "alter publication supabase_realtime add table public.lr_o");
      return { r1, r2 };
    });
    rt.add_heap_table_to_supabase_realtime = pubAdd.r1.ok ? "ok" : pubAdd.r1.error;
    rt.add_oriole_table_to_supabase_realtime = pubAdd.r2.ok ? "ok" : pubAdd.r2.error;
    const waitS = Number(process.env.OR_RT_WAIT_S ?? "25");
    let r: RtResult = { joined: "", system: [], events: {}, types: {}, error: "" };
    for (let attempt = 0; attempt < 3; attempt++) {
      await withConn(proj, (c) => c.query("truncate public.lr_o, public.lr_h"));
      r = await realtime(
        proj.ref,
        keys.anon,
        async () => {
          await withConn(proj, async (c) => {
            for (const t of ["lr_o", "lr_h"]) for (const s of DML(t)) await tryQuery(c, s);
          });
        },
        waitS,
      );
      if (!r.error) break;
      await sleep(15_000);
    }
    rt.join_status = r.joined || "(none)";
    rt.subscribe_error = r.error || "(none)";
    rt.system_messages = r.system.join(" | ").slice(0, 400);
    for (const t of ["lr_o", "lr_h"]) {
      for (const ty of ["INSERT", "UPDATE", "DELETE"]) rt[`${t}_${ty}_events`] = r.events[`${t}:${ty}`] ?? 0;
    }
    const oN = ["INSERT", "UPDATE", "DELETE"].reduce((s, ty) => s + Number(rt[`lr_o_${ty}_events`]), 0);
    const hN = ["INSERT", "UPDATE", "DELETE"].reduce((s, ty) => s + Number(rt[`lr_h_${ty}_events`]), 0);
    out.push({
      id: `${ID}b`,
      title: "OR07b: Realtime postgres_changes events, OrioleDB table vs heap table",
      status: "info",
      detail: `events received after 3 INSERT, 2 UPDATE, 1 DELETE per table: OrioleDB table ${oN} of 6, heap table ${hN} of 6${r.error ? `; subscribe error: ${r.error}` : ""}`,
      measurements: rt,
    });

    const d: Record<string, string | number> = {};
    await withConn(proj, async (c) => {
      await tryQuery(c, "grant usage on schema public to anon");
      await tryQuery(c, "grant select, insert on public.lr_o, public.lr_h to anon");
      await tryQuery(c, "notify pgrst, 'reload schema'");
    });
    await sleep(5_000);
    for (const t of ["lr_o", "lr_h"]) {
      const h = { apikey: keys.anon, Authorization: `Bearer ${keys.anon}`, "Content-Type": "application/json", Prefer: "return=representation" };
      let g = await fetch(`https://${proj.ref}.supabase.co/rest/v1/${t}?select=*`, { headers: h });
      for (let i = 0; i < 3 && g.status === 404; i++) {
        await sleep(5_000);
        g = await fetch(`https://${proj.ref}.supabase.co/rest/v1/${t}?select=*`, { headers: h });
      }
      const gt = await g.text();
      d[`${t}_get_status`] = g.status;
      d[`${t}_get_body_bytes`] = gt.length;
      const p = await fetch(`https://${proj.ref}.supabase.co/rest/v1/${t}`, { method: "POST", headers: h, body: JSON.stringify({ id: 10, v: "via-rest" }) });
      d[`${t}_post_status`] = p.status;
      if (p.status >= 300) d[`${t}_post_error`] = (await p.text()).slice(0, 200);
    }
    out.push({
      id: `${ID}c`,
      title: "OR07c: Data API GET and POST on an OrioleDB table vs a heap table",
      status: "info",
      detail: `GET ${d.lr_o_get_status}/${d.lr_h_get_status}, POST ${d.lr_o_post_status}/${d.lr_h_post_status} (OrioleDB table / heap table)`,
      measurements: d,
    });
    await withConn(proj, (c) => tryQuery(c, "drop table if exists public.lr_o, public.lr_h cascade"));
    return out;
  },
};

export default mod;
