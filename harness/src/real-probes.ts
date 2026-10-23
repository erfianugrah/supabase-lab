/**
 * Data-path probes for the multi-path sampler (sampler.ts), shared by every
 * experiment that times a platform operation.
 *
 * Why these exist: the earlier HTTP probes (platform-downtime lib/probes.ts,
 * medium-serverless lib/setup.ts) sent an anon `GET /rest/v1/` and counted any
 * status below 500 as up. The API gateway answers that request with 401
 * before PostgREST or the database is reached, so "REST never failed" meant
 * "the HTTP tier answered", not "a client could read a row". Their Realtime probe counted a
 * completed WebSocket handshake as up, which never joins a channel or touches
 * the project's database. The probes here are only up when the data arrives:
 *
 *   rest_read      GET /rest/v1/pvlab_probe?id=eq.1&select=id with the anon
 *                  key; up only on HTTP 200 with exactly [{"id":1}].
 *   realtime_join  new socket, phx_join with a Postgres Changes subscription on
 *                  pvlab_probe and broadcast self-echo; up only when the join
 *                  is acknowledged, the postgres_changes system message says
 *                  ok, and our own broadcast (fresh nonce) comes back.
 *
 * `seedProbeTable` creates the table, grants and publication entry these need
 * and waits until both probes pass three times in a row, so a module can start
 * sampling from a known-good state. It is idempotent.
 *
 * The Realtime probe uses Bun's built-in WebSocket, not the `ws` package the
 * older probes import: on 2026-10-23 the same join through `ws` under Bun
 * closed after the subscription was confirmed and never saw its own echo,
 * while the built-in client received the join reply, "Subscribed to
 * PostgreSQL" and the echo within about 150 ms on the same project.
 *
 * Failure texts are kept short and stable (`HTTP 503 PGRST002`,
 * `pg_changes: Too many database timeouts`) because the sampler records the
 * distinct modes and they are what a reader compares across runs.
 */
import type { Probe, ProbeOutcome } from "./sampler";
import type { Ctx } from "./types";
import { sql } from "./platform";

export const PROBE_TABLE = "pvlab_probe";
export const REST_TIMEOUT_MS = 5000;
/** A fresh tenant's first subscription can take about 11 s (realtime-surface RT01a); steady state is far below. */
export const REALTIME_TIMEOUT_MS = 10_000;

/** Pure: an HTTP status and body from the rest_read request -> sampler outcome. */
export function classifyRestRead(status: number, body: string): ProbeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: status === 200 ? "HTTP 200 non-json" : `HTTP ${status}` };
  }
  if (status === 200) {
    const rows = Array.isArray(parsed) ? (parsed as { id?: unknown }[]) : [];
    return rows.length === 1 && rows[0]?.id === 1 ? { ok: true } : { ok: false, error: "HTTP 200 row-missing" };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const code = String(o.code ?? o.message ?? o.error ?? "").replace(/\s+/g, " ").slice(0, 60);
  return { ok: false, error: code ? `HTTP ${status} ${code}` : `HTTP ${status}` };
}

export function restReadProbe(apiHost: string, anonKey: string, name = "rest_read"): Probe {
  const url = `https://${apiHost}/rest/v1/${PROBE_TABLE}?id=eq.1&select=id`;
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  return {
    name,
    async run() {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
        return classifyRestRead(res.status, await res.text());
      } catch (e) {
        const n = e instanceof Error ? e.name : "";
        return { ok: false, error: n === "TimeoutError" ? "timeout" : (e instanceof Error ? e.message : String(e)).slice(0, 80) };
      }
    },
  };
}

export interface RtFrame {
  topic?: string;
  event?: string;
  ref?: string | null;
  payload?: Record<string, unknown>;
}

export type RtStep =
  | { kind: "joined" }
  | { kind: "subscribed" }
  | { kind: "delivered" }
  | { kind: "fail"; error: string }
  | { kind: "ignore" };

/** Pure: one Phoenix frame on our topic -> what it means for the probe. */
export function classifyRealtimeFrame(f: RtFrame, topic: string, nonce: string): RtStep {
  if (f.topic !== topic) return { kind: "ignore" };
  const p = (f.payload ?? {}) as Record<string, unknown>;
  switch (f.event) {
    case "phx_reply": {
      if (f.ref !== "1") return { kind: "ignore" };
      if (p.status === "ok") return { kind: "joined" };
      const reason = (p.response as Record<string, unknown> | undefined)?.reason ?? p.status ?? "error";
      return { kind: "fail", error: `join: ${String(reason).slice(0, 80)}` };
    }
    case "system": {
      if (p.extension !== "postgres_changes") return { kind: "ignore" };
      return p.status === "ok" ? { kind: "subscribed" } : { kind: "fail", error: `pg_changes: ${String(p.message ?? p.status).slice(0, 80)}` };
    }
    case "broadcast": {
      const inner = (p.payload ?? {}) as Record<string, unknown>;
      return inner.nonce === nonce ? { kind: "delivered" } : { kind: "ignore" };
    }
    case "phx_error":
    case "phx_close":
      return { kind: "fail", error: `channel: ${f.event}` };
    default:
      return { kind: "ignore" };
  }
}

export function realtimeJoinProbe(apiHost: string, anonKey: string, name = "realtime_join"): Probe {
  const url = `wss://${apiHost}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;
  const topic = "realtime:pvlab-probe";
  return {
    name,
    async run() {
      const nonce = crypto.randomUUID();
      return await new Promise<ProbeOutcome>((resolve) => {
        let joined = false;
        let subscribed = false;
        let sent = false;
        let stage = "handshake";
        let finished = false;
        const ws = new WebSocket(url);
        const timer = setTimeout(() => done({ ok: false, error: `timeout at ${stage}` }), REALTIME_TIMEOUT_MS);
        function done(o: ProbeOutcome) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          resolve(o);
        }
        const send = (m: unknown) => ws.send(JSON.stringify(m));
        ws.addEventListener("open", () => {
          stage = "join";
          send({
            topic,
            event: "phx_join",
            ref: "1",
            join_ref: "1",
            payload: {
              config: {
                broadcast: { self: true, ack: false },
                presence: { key: "" },
                postgres_changes: [{ event: "*", schema: "public", table: PROBE_TABLE }],
                private: false,
              },
              access_token: anonKey,
            },
          });
        });
        ws.addEventListener("message", (ev: MessageEvent) => {
          let f: RtFrame;
          try {
            const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
            f = JSON.parse(raw) as RtFrame;
          } catch {
            return;
          }
          const step = classifyRealtimeFrame(f, topic, nonce);
          if (step.kind === "fail") return done({ ok: false, error: step.error });
          if (step.kind === "joined") joined = true;
          if (step.kind === "subscribed") subscribed = true;
          if (step.kind === "delivered") return done({ ok: true });
          if (joined) stage = subscribed ? "broadcast" : "pg_changes";
          if (joined && subscribed && !sent) {
            sent = true;
            send({ topic, event: "broadcast", ref: "2", join_ref: "1", payload: { type: "broadcast", event: "ping", payload: { nonce } } });
          }
        });
        ws.addEventListener("error", () => done({ ok: false, error: `ws error at ${stage}` }));
        ws.addEventListener("close", (ev: CloseEvent) => done({ ok: false, error: `closed ${ev.code} at ${stage}` }));
      });
    },
  };
}

const SEED_SQL = `
create table if not exists public.${PROBE_TABLE} (id int primary key, v text not null);
insert into public.${PROBE_TABLE} values (1, 'ok') on conflict (id) do nothing;
alter table public.${PROBE_TABLE} enable row level security;
drop policy if exists ${PROBE_TABLE}_read on public.${PROBE_TABLE};
create policy ${PROBE_TABLE}_read on public.${PROBE_TABLE} for select to anon using (true);
grant select on public.${PROBE_TABLE} to anon;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = '${PROBE_TABLE}') then
    alter publication supabase_realtime add table public.${PROBE_TABLE};
  end if;
end $$;
notify pgrst, 'reload schema';
`;

/**
 * Create the probe table and wait until rest_read and realtime_join both pass
 * `need` times in a row. Returns seconds waited, or throws with the last
 * failure of each probe so a module can skip with a reason.
 */
export async function seedProbeTable(
  ctx: Ctx,
  apiHost: string,
  anonKey: string,
  opts: { need?: number; maxMs?: number } = {},
): Promise<number> {
  const need = opts.need ?? 3;
  const maxMs = opts.maxMs ?? 180_000;
  const r = await sql(ctx, SEED_SQL);
  if (r.status >= 300) throw new Error(`seed ${PROBE_TABLE}: HTTP ${r.status} ${r.error}`);
  const probes = [restReadProbe(apiHost, anonKey), realtimeJoinProbe(apiHost, anonKey)];
  const t0 = Date.now();
  let streak = 0;
  let last: string[] = [];
  while (Date.now() - t0 < maxMs) {
    const outs = await Promise.all(probes.map((p) => p.run()));
    last = outs.map((o, i) => `${probes[i]?.name}=${o.ok ? "ok" : o.error}`);
    streak = outs.every((o) => o.ok) ? streak + 1 : 0;
    if (streak >= need) return Math.round((Date.now() - t0) / 1000);
    await Bun.sleep(2000);
  }
  throw new Error(`probe table never served on both paths within ${maxMs / 1000}s: ${last.join(", ")}`);
}
