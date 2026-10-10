/**
 * RT04 - Broadcast binary payloads: the three send paths, receivers on the
 * current supabase-js and on an old one, and private-channel RLS.
 *
 * Public claim (https://supabase.com/changelog/46834-realtime-broadcast-now-supports-binary-payloads):
 * binary payloads go over WebSocket (ArrayBuffer / ArrayBufferView),
 * REST (`Content-Type: application/octet-stream`) and the database
 * (`realtime.send_binary(bytea, ...)`); the changelog names minimum client
 * and server versions and says SDKs without binary support drop binary
 * payloads silently. The old receiver here is the package pinned in this
 * experiment's package.json (`supabase-js-2-90`, run `bun install` in the
 * experiment dir); rows that need it skip when it is absent.
 *
 * One throwaway Pro project. An authenticated user and policies on
 * `realtime.messages`: topic `rt04:a` readable and writable, `rt04:ro`
 * readable only, `rt04:denied` neither.
 *
 *   RT04a-<path>-<receiver>  one row per send path and receiver: events with
 *                            the sent event name, byte-for-byte equality, the
 *                            JavaScript type the payload arrived as. Paths:
 *                            ws-u8 (Uint8Array), ws-ab (ArrayBuffer),
 *                            http-u8 (httpSend), rest-raw (fetch with
 *                            octet-stream), sql (realtime.send_binary), and
 *                            JSON controls ws-json, http-json, rest-json,
 *                            sql-json. Receivers: cur, old.
 *   RT04b-old-sender         the old client sends a Uint8Array (WebSocket and
 *                            httpSend); what the current receiver gets
 *   RT04c-<case>             RLS: denied topic join, read-only topic send over
 *                            WebSocket / REST / anon REST, binary and JSON
 *   RT04d                    what `realtime.messages` stored for the binary
 *                            database send
 *
 * DESTRUCTIVE: creates and deletes a project.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { anonClient, bytesEq, ddl, dropMessagePolicies, warmMessages, errText, makeUser, newState, pgConnect, sleep, subscribeAndWait, userClient, withProject, skipWithoutOrg, type Proj, type SubState, type TestUser } from "../lib/rt";

interface Got {
  event: string;
  kind: string;
  bytes?: Uint8Array;
  json?: unknown;
  /** a JSON object keyed "0".."n-1" with byte values: what JSON.stringify makes of a Uint8Array */
  indexed?: Uint8Array;
}

const PAYLOAD = Uint8Array.from([0, 1, 2, 3, 127, 128, 200, 254, 255, 0, 255, 0, 16, 32, 64, 128]);
const BIG = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 255);

function classify(payload: any): Pick<Got, "kind" | "bytes" | "json" | "indexed"> {
  if (payload instanceof ArrayBuffer) return { kind: "ArrayBuffer", bytes: new Uint8Array(payload) };
  if (ArrayBuffer.isView(payload)) return { kind: payload.constructor.name, bytes: new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength) };
  const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
  const indexed = keys.length > 0 && keys.every((k, i) => k === String(i)) ? Uint8Array.from(keys.map((k) => Number(payload[k]))) : undefined;
  return { kind: indexed ? "json-indexed-object" : typeof payload, json: payload, indexed };
}

interface Recv {
  label: string;
  client: SupabaseClient;
  st: SubState;
  got: Got[];
  topic: string;
}

async function receiver(label: string, client: SupabaseClient, topic: string): Promise<Recv> {
  const st = newState();
  const got: Got[] = [];
  const ch = client.channel(topic, { config: { private: true } as any });
  ch.on("broadcast", { event: "*" }, (m: any) => got.push({ event: String(m.event), ...classify(m.payload) }));
  await subscribeAndWait(ch, st);
  return { label, client, st, got, topic };
}

const nameOf = (g: Got) => `${g.event}/${g.kind}`;

const mod: TestModule = {
  id: "RT04",
  title: "Broadcast binary: WebSocket / REST / database send, current vs old receiver, private-channel RLS",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const put = (r: TestResult) => out.push(r);
    const skip = skipWithoutOrg(ctx, "RT04", "RT04");
    if (skip) return skip;
    try {
      await withProject(ctx, "rt04", async (p: Proj) => {
        const warm = await warmMessages(p);
        put({
          id: "RT04-warm",
          title: "RT04-warm: realtime.messages before and after the first Realtime connection",
          status: warm.partitionMs >= 0 ? "pass" : "fail",
          detail: `at first healthy read: table ${warm.preExists ? "present" : "absent"}, ${warm.prePartitions} partition(s); Realtime join answered after ${warm.realtimeReadyMs} ms; today's partition present ${warm.partitionMs} ms later`,
          measurements: { table_present_before_connect: warm.preExists ? 1 : 0, partitions_before_connect: warm.prePartitions, realtime_join_ms: warm.realtimeReadyMs, partition_after_connect_ms: warm.partitionMs },
        });
        const user: TestUser = await makeUser(p, "rt04");
        await ddl(
          p,
          `${dropMessagePolicies}
           create policy rt04_read on realtime.messages for select to authenticated using (realtime.topic() in ('rt04:a','rt04:ro'));
           create policy rt04_write on realtime.messages for insert to authenticated with check (realtime.topic() = 'rt04:a');`,
        );
        const pg = await pgConnect(p);

        // old SDK, loaded by variable specifier so the typecheck does not need it installed
        let oldVersion = "";
        let oldCreate: ((url: string, key: string, opts: unknown) => SupabaseClient) | undefined;
        try {
          const spec: string = "supabase-js-2-90";
          const m = (await import(spec)) as { createClient: typeof createClient };
          oldCreate = m.createClient as never;
          oldVersion = String((await Bun.file(new URL("../node_modules/supabase-js-2-90/package.json", import.meta.url)).json()).version);
        } catch (e) {
          put({ id: "RT04-old-sdk", title: "RT04-old-sdk", status: "skip", detail: `old supabase-js not installed (bun install in the experiment dir): ${errText(e)}` });
        }
        const curVersion = String((await Bun.file(new URL("../../../node_modules/@supabase/supabase-js/package.json", import.meta.url)).json()).version);
        const mkOld = async () => {
          const c = oldCreate!(p.url, p.anon, { auth: { persistSession: false, autoRefreshToken: false } });
          const { error } = await c.auth.signInWithPassword({ email: user.email, password: user.password });
          if (error) throw new Error(`old client sign-in failed: ${error.message}`);
          return c;
        };

        const cur = await receiver("cur", await userClient(p, user), "rt04:a");
        const old = oldCreate ? await receiver("old", await mkOld(), "rt04:a") : undefined;
        const recvs = [cur, ...(old ? [old] : [])];
        put({
          id: "RT04-setup",
          title: "RT04-setup: receivers joined",
          status: cur.st.status === "SUBSCRIBED" && (!old || old.st.status === "SUBSCRIBED") ? "pass" : "fail",
          detail: `current supabase-js ${curVersion}: ${cur.st.status}${cur.st.err ? ` (${cur.st.err})` : ""}; old ${oldVersion || "absent"}: ${old ? old.st.status + (old.st.err ? ` (${old.st.err})` : "") : "-"}`,
          measurements: { current_version: curVersion, old_version: oldVersion || "absent", current_join: cur.st.status, old_join: old?.st.status ?? "n/a" },
        });

        const sender = await userClient(p, user);
        const sch = sender.channel("rt04:a", { config: { private: true, broadcast: { ack: true } } as any });
        const sst = newState();
        await subscribeAndWait(sch, sst);

        const hex = (b: Uint8Array) => `\\x${Buffer.from(b).toString("hex")}`;
        const base = `${p.url}/realtime/v1/api/broadcast/rt04:a/events`;
        const restHeaders = { apikey: p.anon, Authorization: `Bearer ${user.token}` };

        type PathDef = { name: string; event: string; expect: Uint8Array | "json"; send: () => Promise<string> };
        const paths: PathDef[] = [
          { name: "ws-u8", event: "bin", expect: PAYLOAD, send: async () => String(await sch.send({ type: "broadcast", event: "bin", payload: PAYLOAD })) },
          { name: "ws-ab", event: "bin", expect: PAYLOAD, send: async () => String(await sch.send({ type: "broadcast", event: "bin", payload: PAYLOAD.buffer.slice(0) })) },
          { name: "ws-u8-4k", event: "bin", expect: BIG, send: async () => String(await sch.send({ type: "broadcast", event: "bin", payload: BIG })) },
          { name: "http-u8", event: "bin", expect: PAYLOAD, send: async () => JSON.stringify(await sch.httpSend("bin", PAYLOAD).catch((e: unknown) => ({ error: errText(e) }))) },
          {
            name: "rest-raw",
            event: "bin",
            expect: PAYLOAD,
            send: async () => {
              const r = await fetch(`${base}/bin?private=true`, { method: "POST", headers: { ...restHeaders, "Content-Type": "application/octet-stream" }, body: PAYLOAD });
              return `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`;
            },
          },
          { name: "sql", event: "bin", expect: PAYLOAD, send: async () => `rows ${(await pg.query(`select realtime.send_binary('${hex(PAYLOAD)}'::bytea, 'bin', 'rt04:a', true)`)).rowCount}` },
          { name: "ws-json", event: "json", expect: "json", send: async () => String(await sch.send({ type: "broadcast", event: "json", payload: { k: 1 } })) },
          { name: "http-json", event: "json", expect: "json", send: async () => JSON.stringify(await sch.httpSend("json", { k: 1 }).catch((e: unknown) => ({ error: errText(e) }))) },
          {
            name: "rest-json",
            event: "json",
            expect: "json",
            send: async () => {
              const r = await fetch(`${base}/json?private=true`, { method: "POST", headers: { ...restHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ k: 1 }) });
              return `HTTP ${r.status}`;
            },
          },
          { name: "sql-json", event: "json", expect: "json", send: async () => `rows ${(await pg.query(`select realtime.send('{"k":1}'::jsonb, 'json', 'rt04:a', true)`)).rowCount}` },
        ];

        for (const path of paths) {
          for (const r of recvs) r.got.length = 0;
          const sendResult = await path.send().catch((e) => `threw ${errText(e)}`);
          await sleep(3500);
          for (const r of recvs) {
            const hits = r.got.filter((g) => g.event === path.event);
            const exact = path.expect === "json" ? hits.filter((g) => g.json && (g.json as any).k === 1).length : hits.filter((g) => g.bytes && bytesEq(g.bytes, path.expect as Uint8Array)).length;
            put({
              id: `RT04a-${path.name}-${r.label}`,
              title: `RT04a: ${path.name} -> receiver ${r.label} (${r.label === "cur" ? curVersion : oldVersion})`,
              status: "info",
              detail: `send: ${sendResult}; events named ${path.event}: ${hits.length}; exact payload: ${exact}; all events seen [${r.got.map(nameOf)}]`,
              measurements: {
                send_result: sendResult.slice(0, 60),
                events: hits.length,
                exact_payload: exact,
                arrived_as: hits[0]?.kind ?? "none",
                indexed_object_equals_bytes: path.expect !== "json" && hits.some((g) => g.indexed && bytesEq(g.indexed, path.expect as Uint8Array)) ? 1 : 0,
                other_events: r.got.length - hits.length,
              },
            });
          }
        }

        /* ---------- RT04b: old sender ---------- */
        if (oldCreate) {
          const oc = await mkOld();
          const och = (oc as any).channel("rt04:a", { config: { private: true, broadcast: { ack: true } } });
          const ost = newState();
          await subscribeAndWait(och, ost);
          for (const how of ["ws", "http"] as const) {
            cur.got.length = 0;
            let res = "";
            try {
              if (how === "ws") res = String(await och.send({ type: "broadcast", event: "bin", payload: PAYLOAD }));
              else res = JSON.stringify(await (och.httpSend ? och.httpSend("bin", PAYLOAD) : Promise.resolve("no httpSend")));
            } catch (e) {
              res = `threw ${errText(e)}`;
            }
            await sleep(3500);
            const g = cur.got.find((x) => x.event === "bin");
            put({
              id: `RT04b-old-sender-${how}`,
              title: `RT04b: old client (${oldVersion}) sends a Uint8Array via ${how === "ws" ? "WebSocket send" : "httpSend"}; current receiver`,
              status: "info",
              detail: `send: ${res.slice(0, 120)}; current receiver got ${cur.got.length} event(s): ${g ? `${g.kind} ${g.bytes ? `${g.bytes.length} bytes` : JSON.stringify(g.json).slice(0, 100)}` : "none"}`,
              measurements: { events: cur.got.length, arrived_as: g?.kind ?? "none", exact_payload: g?.bytes && bytesEq(g.bytes, PAYLOAD) ? 1 : 0 },
            });
          }
          await oc.removeAllChannels();
          await oc.realtime.disconnect();
        }

        /* ---------- RT04c: RLS ---------- */
        {
          // denied topic: join
          const dn = await receiver("denied", await userClient(p, user), "rt04:denied");
          put({
            id: "RT04c-denied-join",
            title: "RT04c: authenticated user joins a private topic with no select policy",
            status: "info",
            detail: `join ${dn.st.statusLog.map((l) => l.status + (l.err ? `(${l.err})` : "")).join(">")}`,
            measurements: { join: dn.st.status },
          });
          await dn.client.realtime.disconnect();

          // read-only topic: a reader, then binary and JSON from the user over each path
          const ro = await receiver("ro", await userClient(p, user), "rt04:ro");
          const rsender = await userClient(p, user);
          const rch = rsender.channel("rt04:ro", { config: { private: true, broadcast: { ack: true } } as any });
          const rst = newState();
          await subscribeAndWait(rch, rst);
          const roBase = `${p.url}/realtime/v1/api/broadcast/rt04:ro/events`;
          const cases: Array<{ name: string; run: () => Promise<string> }> = [
            { name: "ws-bin", run: async () => String(await rch.send({ type: "broadcast", event: "bin", payload: PAYLOAD })) },
            { name: "ws-json", run: async () => String(await rch.send({ type: "broadcast", event: "json", payload: { k: 1 } })) },
            { name: "rest-user-bin", run: async () => { const r = await fetch(`${roBase}/bin?private=true`, { method: "POST", headers: { ...restHeaders, "Content-Type": "application/octet-stream" }, body: PAYLOAD }); return `HTTP ${r.status}`; } },
            { name: "rest-user-json", run: async () => { const r = await fetch(`${roBase}/json?private=true`, { method: "POST", headers: { ...restHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ k: 1 }) }); return `HTTP ${r.status}`; } },
            { name: "rest-anon-bin", run: async () => { const r = await fetch(`${roBase}/bin?private=true`, { method: "POST", headers: { apikey: p.anon, "Content-Type": "application/octet-stream" }, body: PAYLOAD }); return `HTTP ${r.status} ${(await r.text()).slice(0, 60)}`; } },
            { name: "rest-anon-json", run: async () => { const r = await fetch(`${roBase}/json?private=true`, { method: "POST", headers: { apikey: p.anon, "Content-Type": "application/json" }, body: JSON.stringify({ k: 1 }) }); return `HTTP ${r.status} ${(await r.text()).slice(0, 60)}`; } },
            { name: "rest-service-bin", run: async () => { const r = await fetch(`${roBase}/bin?private=true`, { method: "POST", headers: { apikey: p.service, Authorization: `Bearer ${p.service}`, "Content-Type": "application/octet-stream" }, body: PAYLOAD }); return `HTTP ${r.status}`; } },
          ];
          for (const k of cases) {
            ro.got.length = 0;
            const res = await k.run().catch((e) => `threw ${errText(e)}`);
            await sleep(3000);
            put({
              id: `RT04c-ro-${k.name}`,
              title: `RT04c: read-only topic, ${k.name}`,
              status: "info",
              detail: `send: ${res}; reader received [${ro.got.map(nameOf)}]`,
              measurements: { send_result: res.slice(0, 60), delivered: ro.got.length },
            });
          }
          // anon cannot join a private topic
          const an = await receiver("anon", anonClient(p), "rt04:a");
          put({
            id: "RT04c-anon-join",
            title: "RT04c: anon key joins a private topic",
            status: "info",
            detail: `join ${an.st.statusLog.map((l) => l.status + (l.err ? `(${l.err})` : "")).join(">")}`,
            measurements: { join: an.st.status },
          });
          await an.client.realtime.disconnect();
          await ro.client.realtime.disconnect();
          await rsender.realtime.disconnect();
        }

        /* ---------- RT04d: what the database stored ---------- */
        {
          const r = (
            await pg.query(
              `select extension, event, private, (payload is null) as payload_null, length(binary_payload) as bin_len from realtime.messages where topic = 'rt04:a' and event = 'bin' order by inserted_at desc limit 3`,
            )
          ).rows;
          put({
            id: "RT04d",
            title: "RT04d: realtime.messages rows after the binary and JSON database sends",
            status: "info",
            detail: JSON.stringify(r),
            measurements: { rows: r.length, bin_len: Number(r[0]?.bin_len ?? -1) },
          });
        }
        await sender.removeAllChannels();
        for (const r of recvs) await r.client.realtime.disconnect();
        await sender.realtime.disconnect();
        await pg.end();
      });
    } catch (e) {
      put({ id: "RT04", title: "RT04", status: "fail", detail: `module threw: ${errText(e)}` });
    }
    return out;
  },
};
export default mod;
