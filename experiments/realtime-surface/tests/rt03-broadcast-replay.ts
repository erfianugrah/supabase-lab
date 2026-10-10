/**
 * RT03 - Broadcast Replay: the limit, the `since` window, public channels,
 * and which send paths are replayable.
 *
 * Docs claim (https://supabase.com/docs/guides/realtime/broadcast): replay
 * returns at most 25 messages, only on private channels, only messages sent
 * from the database, stored in daily partitions kept at least 72 hours.
 * One throwaway Pro project, current supabase-js, an authenticated user, and
 * RLS policies on `realtime.messages` that allow that user to read and write.
 *
 *   RT03a  26 messages sent with `select realtime.send(...)` as separate
 *          autocommit statements on one private topic; the rows persisted in
 *          `realtime.messages` (count, distinct inserted_at)
 *   RT03b  a fresh private subscriber per `limit` (omitted, 10, 25, 26, 100)
 *          with `since` before the first message: how many replayed messages
 *          arrive, which ones (oldest or newest), in what order, and any
 *          join error text
 *   RT03c  `since` at the 13th message with limit 25
 *   RT03d  public channel: supabase-js constructor check, then a raw
 *          WebSocket join with `private: false` and a replay config
 *   RT03e  messages sent by a client (WebSocket `send`, REST `httpSend`) on
 *          a private topic: are they persisted in `realtime.messages`, and
 *          does a later subscriber replay them
 *
 * Not measured: the 72-hour partition boundary (needs messages older than the
 * lab can create in a run).
 *
 * DESTRUCTIVE: creates and deletes a project.
 */
import WebSocket from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { anonClient, ddl, dropMessagePolicies, warmMessages, errText, makeUser, newState, pgConnect, rows, sleep, subscribeAndWait, userClient, withProject, skipWithoutOrg, type Proj, type TestUser } from "../lib/rt";

interface Replayed {
  i: number;
  replayed: boolean;
  recvAt: number;
}

async function replaySub(
  c: SupabaseClient,
  topic: string,
  replay: { since: number; limit?: number } | undefined,
  settleMs = 5000,
) {
  const st = newState();
  const got: Replayed[] = [];
  let ch: ReturnType<SupabaseClient["channel"]>;
  let ctorError = "";
  try {
    ch = c.channel(topic, { config: { private: true, ...(replay ? { broadcast: { replay } } : {}) } as any });
  } catch (e) {
    return { st, got, ctorError: errText(e) };
  }
  ch.on("broadcast", { event: "evt" }, (m: any) => {
    got.push({ i: Number(m.payload?.i ?? m.payload?.payload?.i), replayed: !!m.meta?.replayed, recvAt: Date.now() });
  });
  await subscribeAndWait(ch, st);
  await sleep(settleMs);
  await c.removeChannel(ch);
  return { st, got, ctorError };
}

const mod: TestModule = {
  id: "RT03",
  title: "Broadcast Replay: 26 messages vs the 25 cap, since window, public channel, client-sent messages",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const put = (r: TestResult) => out.push(r);
    const skip = skipWithoutOrg(ctx, "RT03", "RT03");
    if (skip) return skip;
    try {
      await withProject(ctx, "rt03", async (p: Proj) => {
        const warm = await warmMessages(p);
        put({
          id: "RT03-warm",
          title: "RT03-warm: realtime.messages before and after the first Realtime connection",
          status: warm.partitionMs >= 0 ? "pass" : "fail",
          detail: `at first healthy read: table ${warm.preExists ? "present" : "absent"}, ${warm.prePartitions} partition(s); Realtime join answered after ${warm.realtimeReadyMs} ms; today's partition present ${warm.partitionMs} ms later`,
          measurements: { table_present_before_connect: warm.preExists ? 1 : 0, partitions_before_connect: warm.prePartitions, realtime_join_ms: warm.realtimeReadyMs, partition_after_connect_ms: warm.partitionMs },
        });
        const user: TestUser = await makeUser(p, "rt03");
        await ddl(
          p,
          `${dropMessagePolicies}
           create policy rt03_read on realtime.messages for select to authenticated using (true);
           create policy rt03_write on realtime.messages for insert to authenticated with check (true);`,
        );
        const pg = await pgConnect(p);
        await pg.query("delete from realtime.messages where topic like 'rt03:%'").catch(() => null); // reused project only
        const dbNowMs = async () => Number((await pg.query("select (extract(epoch from clock_timestamp())*1000)::bigint as ms")).rows[0].ms);

        /* ---------- RT03a: send 26 from the database ---------- */
        const sinceBefore = (await dbNowMs()) - 2000;
        // a first subscriber must exist for nothing: Replay is about messages sent while nobody listens
        for (let i = 1; i <= 26; i++) {
          await pg.query(`select realtime.send(jsonb_build_object('i', $1::int), 'evt', 'rt03:a', true)`, [i]);
          await sleep(120);
        }
        const persisted = (
          await pg.query(
            `select count(*)::int as n, count(distinct inserted_at)::int as d, min(inserted_at)::text as lo, max(inserted_at)::text as hi from realtime.messages where topic = 'rt03:a'`,
          )
        ).rows[0];
        const mid = (
          await pg.query(
            `select (extract(epoch from inserted_at at time zone 'UTC')*1000)::bigint as ms from realtime.messages where topic = 'rt03:a' and (payload->>'i')::int = 13`,
          )
        ).rows[0];
        put({
          id: "RT03a",
          title: "RT03a: 26 realtime.send messages persisted",
          status: persisted.n === 26 ? "pass" : "fail",
          detail: `realtime.messages rows for the topic ${persisted.n}, distinct inserted_at ${persisted.d}`,
          measurements: { persisted: persisted.n, distinct_inserted_at: persisted.d },
        });

        /* ---------- RT03b: limit sweep ---------- */
        for (const limit of [undefined, 10, 25, 26, 100]) {
          const c = await userClient(p, user);
          const r = await replaySub(c, "rt03:a", { since: sinceBefore, ...(limit !== undefined ? { limit } : {}) });
          const replayed = r.got.filter((g) => g.replayed);
          const order = r.got.map((g) => g.i);
          put({
            id: `RT03b-${limit ?? "none"}`,
            title: `RT03b: replay since before the first message, limit ${limit ?? "omitted"}`,
            status: "info",
            detail: r.ctorError
              ? `constructor: ${r.ctorError}`
              : `join ${r.st.statusLog.map((l) => l.status + (l.err ? `(${l.err})` : "")).join(">")}; received ${r.got.length}, replayed ${replayed.length}; first ${order[0] ?? "-"} last ${order.at(-1) ?? "-"}`,
            measurements: {
              subscribe: r.st.statusLog.map((l) => l.status).join(">") || "none", // SUBSCRIBED>CLOSED: the CLOSED is the removeChannel at the end of the settle window
              received: r.got.length,
              replayed: replayed.length,
              first_i: order[0] ?? -1,
              last_i: order.at(-1) ?? -1,
              ascending: order.every((v, k) => k === 0 || v > order[k - 1]!) ? 1 : 0,
            },
            evidence: `${r.st.statusLog.map((l) => `${l.status}${l.err ? `(${l.err})` : ""}`).join(">")}; order [${order}]`,
          });
          await c.realtime.disconnect();
        }

        /* ---------- RT03c: since at message 13 ---------- */
        for (const delta of [0, 1]) {
          const c = await userClient(p, user);
          const since = Number(mid?.ms ?? 0) + delta;
          const r = await replaySub(c, "rt03:a", { since, limit: 25 });
          const order = r.got.map((g) => g.i);
          put({
            id: `RT03c-plus${delta}`,
            title: `RT03c: since = floor(epoch ms of message 13's inserted_at) + ${delta}, limit 25`,
            status: "info",
            detail: `join ${r.st.statusLog.map((l) => l.status).join(">")}; received ${order.length}: [${order}]`,
            measurements: { since_delta_ms: delta, received: order.length, first_i: order[0] ?? -1, last_i: order.at(-1) ?? -1 },
          });
          await c.realtime.disconnect();
        }

        /* ---------- RT03d: public channel ---------- */
        {
          await pg.query(`select realtime.send(jsonb_build_object('i', 1), 'evt', 'rt03:pub', false)`);
          const pubRows = (await pg.query(`select count(*)::int as n from realtime.messages where topic = 'rt03:pub'`)).rows[0].n;
          const c = anonClient(p);
          let ctor = "";
          try {
            c.channel("rt03:pub", { config: { private: false, broadcast: { replay: { since: sinceBefore, limit: 5 } } } as any });
          } catch (e) {
            ctor = errText(e);
          }
          // raw join, bypassing the client-side check
          const raw = await new Promise<{ reply: string; broadcasts: number; frames: string[] }>((resolve) => {
            const frames: string[] = [];
            let broadcasts = 0;
            let reply = "";
            const ws = new WebSocket(`wss://${p.host}/realtime/v1/websocket?apikey=${p.anon}&vsn=1.0.0`);
            const timer = setTimeout(() => {
              try {
                ws.close();
              } catch {}
              resolve({ reply: reply || "no reply", broadcasts, frames });
            }, 8000);
            ws.on("open", () =>
              ws.send(
                JSON.stringify({
                  topic: "realtime:rt03:pub",
                  event: "phx_join",
                  payload: { config: { broadcast: { ack: false, self: false, replay: { since: sinceBefore, limit: 5 } }, presence: { enabled: false }, postgres_changes: [], private: false } },
                  ref: "1",
                  join_ref: "1",
                }),
              ),
            );
            ws.on("message", (d) => {
              const m = JSON.parse(d.toString()) as { event?: string; payload?: any };
              frames.push(`${m.event}:${JSON.stringify(m.payload).slice(0, 160)}`);
              if (m.event === "phx_reply" && !reply) reply = JSON.stringify(m.payload).slice(0, 300);
              if (m.event === "broadcast") broadcasts++;
            });
            ws.on("error", (e) => {
              reply = reply || `ws error ${errText(e)}`;
            });
          });
          put({
            id: "RT03d",
            title: "RT03d: replay on a public channel",
            status: "info",
            detail: `realtime.send(private=false) persisted ${pubRows} row(s); supabase-js constructor: ${ctor || "no error"}; raw join reply ${raw.reply}; broadcast frames ${raw.broadcasts}`,
            measurements: { public_rows_persisted: pubRows, client_ctor_throws: ctor ? 1 : 0, raw_broadcast_frames: raw.broadcasts },
            evidence: `${ctor}\n${raw.frames.join("\n")}`,
          });
          await c.realtime.disconnect();
        }

        /* ---------- RT03e: client-sent messages ---------- */
        {
          const sinceE = (await dbNowMs()) - 1000;
          const sender = await userClient(p, user);
          const st = newState();
          const sch = sender.channel("rt03:b", { config: { private: true, broadcast: { ack: true } } as any });
          await subscribeAndWait(sch, st);
          const wsRes: string[] = [];
          for (let i = 1; i <= 3; i++) wsRes.push(String(await sch.send({ type: "broadcast", event: "evt", payload: { i } })));
          const restRes: string[] = [];
          for (let i = 4; i <= 6; i++) {
            const r = await sch.httpSend("evt", { i }).catch((e: unknown) => ({ success: false, error: errText(e) }));
            restRes.push(JSON.stringify(r));
          }
          await sleep(3000);
          const persistedB = (await pg.query(`select count(*)::int as n from realtime.messages where topic = 'rt03:b'`)).rows[0].n;
          await sender.removeChannel(sch);
          await sender.realtime.disconnect();
          const c = await userClient(p, user);
          const r = await replaySub(c, "rt03:b", { since: sinceE, limit: 25 });
          put({
            id: "RT03e",
            title: "RT03e: client-sent private messages (3 WebSocket send, 3 REST httpSend) and replay",
            status: "info",
            detail: `send results [${wsRes}]; httpSend results [${restRes}]; realtime.messages rows for the topic ${persistedB}; later subscriber replayed ${r.got.filter((g) => g.replayed).length}`,
            measurements: {
              ws_send_ok: wsRes.filter((x) => x === "ok").length,
              http_send_ok: restRes.filter((x) => x.includes('"success":true')).length,
              persisted_rows: persistedB,
              replayed: r.got.filter((g) => g.replayed).length,
              received: r.got.length,
            },
          });
          await c.realtime.disconnect();
        }
        await pg.end();
        void rows;
      });
    } catch (e) {
      put({ id: "RT03", title: "RT03", status: "fail", detail: `module threw: ${errText(e)}` });
    }
    return out;
  },
};
export default mod;
