/**
 * RT02 - what a Postgres Changes subscriber misses while disconnected, and a
 * heartbeat-row canary that notices and backfills over REST.
 *
 * Public claim (https://supabase.com/blog/realtime-or-pipelines-how-to-choose-the-right-tool,
 * published 2026-05-05, "If a client disconnects for 30 seconds and reconnects,
 * the changes that happened during those 30 seconds are gone"):
 * changes that happen while a client is disconnected are not replayed. This
 * module counts it. One throwaway Pro project, current supabase-js, anon
 * subscriber on a table that has RLS off (so RLS cost is not in the picture),
 * rows written with the service key over PostgREST at 1 per second.
 *
 *   RT02a  auto-reconnect: the socket is closed by the client (close code
 *          4000) and the client is configured to wait 30 s before it
 *          reconnects (`reconnectAfterMs`), so the gap is 30 s by
 *          construction. 3 rows before, 25 during, 3 after. Count received
 *          per segment; record the status transitions.
 *   RT02b  manual: `realtime.disconnect()`, 25 rows over 30 s, then
 *          `realtime.connect()`. Records whether the existing channel
 *          rejoins on its own and what it receives; then a fresh channel
 *          is subscribed and its events are counted.
 *   RT02c  heartbeat-row canary: a row in a second table is updated every
 *          2 s; the watcher treats 6 s of silence as stale, tears the client
 *          down, subscribes a new one, then backfills with
 *          `updated_at > last_seen` over REST. Counts live, backfilled,
 *          duplicated and missing rows, and the detect/recover timings.
 *
 * DESTRUCTIVE: creates and deletes a project.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  anonClient,
  ddl,
  errText,
  newState,
  serviceClient,
  sleep,
  subscribeAndWait,
  waitCdc,
  withProject,
  skipWithoutOrg,
  type Proj,
  type SubState,
} from "../lib/rt";

const T = "rt02_t";
const HB = "rt02_hb";

const dropSocket = (c: SupabaseClient, code = 4000) => {
  const rt = c.realtime as any;
  const sock = rt.socketAdapter?.getSocket?.() ?? rt.conn;
  const conn = sock?.conn ?? sock;
  conn?.close?.(code, "rt02-drop");
};

function listen(ch: any, table: string, st: SubState) {
  ch.on("postgres_changes", { event: "*", schema: "public", table }, (e: Record<string, any>) => {
    (e as any)._recvAt = Date.now();
    st.events.push(e);
  });
}

const seqsOf = (st: SubState, phase: string) =>
  st.events.filter((e) => e.new?.phase === phase).map((e) => Number(e.new.seq)).sort((a, b) => a - b);

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const count = (got: number[], r: number[]) => r.filter((x) => got.includes(x)).length;

const mod: TestModule = {
  id: "RT02",
  title: "Postgres Changes: loss during a 30 s disconnect, heartbeat-row canary with REST backfill",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const put = (r: TestResult) => out.push(r);
    const skip = skipWithoutOrg(ctx, "RT02", "RT02");
    if (skip) return skip;
    try {
      await withProject(ctx, "rt02", async (p: Proj) => {
        await ddl(
          p,
          `drop table if exists public.${T}, public.${HB};
           create table public.${T} (id bigint generated always as identity primary key, phase text not null, seq int not null, updated_at timestamptz not null default now());
           create table public.${HB} (id int primary key, beat int not null, updated_at timestamptz not null default now());
           grant select on public.${T}, public.${HB} to anon, authenticated;
           grant all on public.${T}, public.${HB} to service_role;
           alter publication supabase_realtime add table public.${T};
           alter publication supabase_realtime add table public.${HB};
           notify pgrst, 'reload schema';`,
        );
        const cdc = await waitCdc(p, T, (k) => `insert into public.${T} (phase, seq) values ('warm', ${k})`);
        const cdcMs = cdc.ms;
        await sleep(3000); // late canary events and the PostgREST schema reload
        const svc = serviceClient(p);
        const ins = async (phase: string, seq: number) => {
          const t = Date.now();
          const r = await svc.from(T).insert({ phase, seq });
          return { seq, at: t, err: r.error?.message ?? "" };
        };
        put({
          id: "RT02-setup",
          title: "RT02-setup: first change event on a fresh project",
          status: cdcMs >= 0 ? "pass" : "fail",
          detail: `first event ${cdcMs} ms after subscribing, from canary insert ${cdc.firstDeliveredInsert} of ${cdc.inserts} (one every 10 s)`,
          measurements: { first_change_event_ms: cdcMs, canary_inserts: cdc.inserts, first_delivered_canary: cdc.firstDeliveredInsert },
        });

        /* ---------- RT02a: auto-reconnect after 30 s ---------- */
        {
          const c = anonClient(p, { realtime: { reconnectAfterMs: () => 30_000 } });
          const st = newState();
          const ch = c.channel("rt02a");
          listen(ch, T, st);
          await subscribeAndWait(ch, st);
          const t0 = Date.now();
          const log = () => st.statusLog.map((l) => `${((l.t - t0) / 1000).toFixed(1)}s:${l.status}`).join(" ");
          for (const s of [1, 2, 3]) {
            await ins("A", s);
            await sleep(1000);
          }
          await sleep(1500);
          const preGot = seqsOf(st, "A");
          const dropAt = Date.now();
          dropSocket(c);
          const writeErrors: string[] = [];
          for (let k = 1; k <= 25; k++) {
            const wait = dropAt + k * 1000 - Date.now();
            if (wait > 0) await sleep(wait);
            const r = await ins("A", 3 + k);
            if (r.err) writeErrors.push(r.err);
          }
          // wait for the client's own reconnect and rejoin (30 s after the drop, plus the join)
          const rejoinDeadline = dropAt + 60_000;
          let rejoinAt = -1;
          while (Date.now() < rejoinDeadline && rejoinAt < 0) {
            const l = st.statusLog.filter((x) => x.t > dropAt + 2000 && x.status === "SUBSCRIBED")[0];
            if (l) rejoinAt = l.t;
            else await sleep(250);
          }
          await sleep(1500);
          for (const s of [29, 30, 31]) {
            await ins("A", s);
            await sleep(1000);
          }
          await sleep(5000);
          const got = seqsOf(st, "A");
          const gapRange = range(4, 28);
          put({
            id: "RT02a",
            title: "RT02a: auto-reconnect after a 30 s gap, 25 rows inserted during it",
            status: "info",
            detail: `before ${count(got, [1, 2, 3])}/3, during gap ${count(got, gapRange)}/25, after rejoin ${count(got, [29, 30, 31])}/3; rejoined ${rejoinAt > 0 ? `${((rejoinAt - dropAt) / 1000).toFixed(1)} s after the drop` : "never within 60 s"}; status ${log()}`,
            measurements: {
              before_gap_received: count(preGot, [1, 2, 3]),
              gap_rows: 25,
              gap_received: count(got, gapRange),
              after_rejoin_received: count(got, [29, 30, 31]),
              rejoin_s: rejoinAt > 0 ? Math.round((rejoinAt - dropAt) / 100) / 10 : -1,
              write_errors: writeErrors.length,
              received_total: got.length,
            },
            evidence: `received seqs: ${got.join(",")}`,
          });
          await c.removeAllChannels();
          await c.realtime.disconnect();
        }

        /* ---------- RT02b: manual disconnect / connect ---------- */
        {
          const c = anonClient(p);
          const st = newState();
          const ch = c.channel("rt02b-1");
          listen(ch, T, st);
          await subscribeAndWait(ch, st);
          for (const s of [1, 2, 3]) {
            await ins("B", s);
            await sleep(1000);
          }
          await sleep(1500);
          const dropAt = Date.now();
          await c.realtime.disconnect();
          for (let k = 1; k <= 25; k++) {
            const wait = dropAt + k * 1000 - Date.now();
            if (wait > 0) await sleep(wait);
            await ins("B", 3 + k);
          }
          const wait = dropAt + 30_000 - Date.now();
          if (wait > 0) await sleep(wait);
          const connectAt = Date.now();
          c.realtime.connect();
          await sleep(6000);
          const sameChannelState = String((ch as any).state);
          const afterConnectGot = seqsOf(st, "B");
          // a fresh channel on the reconnected client
          const st2 = newState();
          const ch2 = c.channel("rt02b-2");
          listen(ch2, T, st2);
          await subscribeAndWait(ch2, st2);
          await ins("B", 29);
          await sleep(3000);
          put({
            id: "RT02b",
            title: "RT02b: manual disconnect, 25 rows over 30 s, connect",
            status: "info",
            detail: `old channel state after connect: ${sameChannelState}; old channel received ${afterConnectGot.length} (gap rows ${count(afterConnectGot, range(4, 28))}/25); fresh channel subscribe ${st2.status}, received seqs [${seqsOf(st2, "B")}] (only seq 29 was inserted after it joined)`,
            measurements: {
              gap_rows: 25,
              old_channel_state_after_connect: sameChannelState,
              old_channel_gap_received: count(afterConnectGot, range(4, 28)),
              old_channel_received_seq29: seqsOf(st, "B").includes(29) ? 1 : 0,
              fresh_channel_received_total: st2.events.length,
              fresh_channel_gap_rows_received: count(seqsOf(st2, "B"), range(4, 28)),
            },
            evidence: `old channel seqs: ${afterConnectGot.join(",")}; connect issued ${Math.round((connectAt - dropAt) / 100) / 10} s after the drop`,
          });
          await c.removeAllChannels();
          await c.realtime.disconnect();
        }

        /* ---------- RT02c: heartbeat-row canary ---------- */
        {
          const STALE_MS = 6000;
          const HB_MS = 2000;
          await ddl(p, `insert into public.${HB} (id, beat) values (1, 0) on conflict (id) do update set beat = 0`);
          let client = anonClient(p, { realtime: { reconnectAfterMs: () => 600_000 } }); // never reconnects on its own in this window
          const live = new Map<number, number>(); // id -> seq
          let lastSeenTs = ""; // max updated_at of data events/backfill
          let lastBeatAt = Date.now();
          let beats = 0;
          const attach = (ch: any, tag: string) => {
            ch.on("postgres_changes", { event: "*", schema: "public", table: T }, (e: Record<string, any>) => {
              if (e.new?.phase !== "C") return;
              if (!live.has(e.new.id)) live.set(e.new.id, e.new.seq);
              (liveBy[tag] ??= new Set()).add(Number(e.new.id));
              if (String(e.new.updated_at) > lastSeenTs) lastSeenTs = String(e.new.updated_at);
            });
            ch.on("postgres_changes", { event: "*", schema: "public", table: HB }, () => {
              lastBeatAt = Date.now();
              beats++;
            });
          };
          const liveBy: Record<string, Set<number>> = {};
          const st = newState();
          const ch1 = client.channel("rt02c-1");
          attach(ch1, "first");
          await subscribeAndWait(ch1, st);
          lastBeatAt = Date.now();

          const TOTAL = 40; // rows, 1 per second
          const inserted: number[] = [];
          let writerDone = false;
          const t0 = Date.now();
          const writer = (async () => {
            for (let s = 1; s <= TOTAL; s++) {
              const wait = t0 + s * 1000 - Date.now();
              if (wait > 0) await sleep(wait);
              const r = await ins("C", s);
              if (!r.err) inserted.push(s);
            }
            writerDone = true;
          })();
          const beater = (async () => {
            let b = 0;
            while (!writerDone) {
              b++;
              await svc.from(HB).update({ beat: b, updated_at: new Date().toISOString() }).eq("id", 1);
              await sleep(HB_MS);
            }
          })();

          await sleep(10_000);
          const dropAt = Date.now();
          dropSocket(client);
          let staleAt = -1;
          let resubscribedAt = -1;
          let backfillDoneAt = -1;
          let backfilled: Array<{ id: number; seq: number }> = [];
          let backfillStatus = "";
          let lastSeenAtBackfill = "";
          while (!writerDone) {
            if (staleAt < 0 && Date.now() - lastBeatAt > STALE_MS) {
              staleAt = Date.now();
              lastSeenAtBackfill = lastSeenTs;
              await client.removeAllChannels();
              await client.realtime.disconnect();
              client = anonClient(p);
              const st2 = newState();
              const ch2 = client.channel("rt02c-2");
              attach(ch2, "second");
              await subscribeAndWait(ch2, st2);
              resubscribedAt = Date.now();
              backfillStatus = st2.status;
              const q = svc.from(T).select("id,seq,updated_at").eq("phase", "C").order("updated_at", { ascending: true });
              const r = lastSeenAtBackfill ? await q.gt("updated_at", lastSeenAtBackfill) : await q;
              backfilled = (r.data ?? []).map((x: any) => ({ id: Number(x.id), seq: Number(x.seq) }));
              for (const b of backfilled) if (!live.has(b.id)) live.set(b.id, b.seq);
              backfillDoneAt = Date.now();
            }
            await sleep(250);
          }
          await writer;
          await beater;
          await sleep(4000);
          const first = liveBy.first ?? new Set<number>();
          const second = liveBy.second ?? new Set<number>();
          const backfillIds = new Set(backfilled.map((b) => b.id));
          const dupes = [...backfillIds].filter((i) => second.has(i)).length;
          const dbRows = (await svc.from(T).select("id,seq").eq("phase", "C")).data ?? [];
          const dbSeqs = new Set(dbRows.map((r: any) => Number(r.seq)));
          const seen = new Set<number>(live.values());
          const missing = [...dbSeqs].filter((s) => !seen.has(s));
          put({
            id: "RT02c",
            title: "RT02c: heartbeat canary detects the stall, resubscribes, backfills by updated_at",
            status: missing.length === 0 && staleAt > 0 ? "pass" : "fail",
            detail: `rows in table ${dbSeqs.size}; live on first channel ${first.size}; live on second ${second.size}; backfilled ${backfilled.length} (duplicates of live-second ${dupes}); missing after union ${missing.length}; stale detected ${staleAt > 0 ? `${((staleAt - dropAt) / 1000).toFixed(1)} s` : "never"} after the drop`,
            measurements: {
              rows_inserted: dbSeqs.size,
              live_first_channel: first.size,
              live_second_channel: second.size,
              backfilled: backfilled.length,
              backfill_duplicates_of_live: dupes,
              missing_after_union: missing.length,
              detect_s: staleAt > 0 ? Math.round((staleAt - dropAt) / 100) / 10 : -1,
              resubscribe_s: resubscribedAt > 0 ? Math.round((resubscribedAt - staleAt) / 100) / 10 : -1,
              backfill_s: backfillDoneAt > 0 ? Math.round((backfillDoneAt - resubscribedAt) / 100) / 10 : -1,
              heartbeat_events: beats,
              second_subscribe: backfillStatus,
              stale_threshold_s: STALE_MS / 1000,
              heartbeat_interval_s: HB_MS / 1000,
            },
            evidence: `missing seqs: [${missing}]; backfilled seqs: [${backfilled.map((b) => b.seq).sort((a, b) => a - b)}]`,
          });
          await client.removeAllChannels();
          await client.realtime.disconnect();
        }
      });
    } catch (e) {
      put({ id: "RT02", title: "RT02", status: "fail", detail: `module threw: ${errText(e)}` });
    }
    return out;
  },
};
export default mod;
