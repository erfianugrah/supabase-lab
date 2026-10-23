/**
 * Raw-protocol subscription burst for RT05: open S WebSockets (paced, so the
 * connection rate is not the thing being measured), then fire every channel
 * join at once (or at a fixed join rate), record what the server answered for
 * EACH channel, then insert one row and time its arrival on every channel.
 *
 * Raw `phx_join` frames rather than supabase-js: a burst needs every channel's
 * `phx_reply` and `system` frame (the latter carries "Too many database
 * timeouts") recorded verbatim, without a client object and its own
 * rejoin logic per socket, for up to 5000 sockets in one process. Protocol
 * shape: https://supabase.com/docs/guides/realtime/protocol (vsn 1.0.0, JSON
 * object frames, as RT03d).
 *
 * Classification per channel (`outcome`):
 *   ready            pc: phx_reply ok AND system {extension postgres_changes,
 *                    status ok}; bc: phx_reply ok
 *   join_error:<code> phx_reply status error; <code> is the text before the
 *                    first ':' of response.reason (the protocol's error code)
 *   pc_error:<msg>   phx_reply ok, then a postgres_changes system error
 *   sys_error:<msg>  channel-level system error (followed by phx_close)
 *   closed:<event>   phx_close / phx_error before ready
 *   socket:<why>     the WebSocket never opened or closed before ready
 *   no_reply         no phx_reply within the settle window (client-side wait)
 *   no_system        pc only: phx_reply ok but no system frame in the window
 */
import WebSocket from "ws";
export type Q = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
import { sleep } from "./rt";

export type Kind = "pc" | "bc";

export interface BurstSpec {
  host: string;
  anon: string;
  tokens: string[];
  kind: Kind;
  sockets: number;
  channelsPerSocket: number;
  /** socket opens per second */
  connectRate: number;
  /** joins per second across all sockets; 0 = all at once */
  joinRate: number;
  /** how long after the last join to wait for every channel to settle */
  settleMs: number;
  table: string;
  /** bc: the private topic every socket joins (one channel per socket) */
  bcTopic: string;
  /** the tenant every test user is a member of; inserts carry it explicitly */
  tenantId: string;
  runTag: string;
}

interface Chan {
  sock: number;
  topic: string;
  ref: string;
  joinSentAt: number;
  replyAt: number;
  readyAt: number;
  outcome: string;
  replyText: string;
  recvAt: number;
}

interface Sock {
  i: number;
  ws: WebSocket | null;
  open: boolean;
  openErr: string;
  closedWhy: string;
  hb?: ReturnType<typeof setInterval>;
}

export interface BurstResult {
  socketsOpened: number;
  socketOpenFailures: Record<string, number>;
  channels: number;
  ready: number;
  outcomes: Record<string, number>;
  /** examples of verbatim reply/system text per outcome */
  samples: Record<string, string>;
  joinToReadyP50: number;
  joinToReadyP95: number;
  joinToReadyMax: number;
  burstWallMs: number;
  serverSubscriptions: number;
  /** max realtime-owned DB connections seen while the burst settled, by usename/application_name */
  dbConnMax: Record<string, number>;
  fanout: { delivered: number; of: number; p50: number; p95: number; max: number; insertAckMs: number };
  /** canaries sent before the first reached any channel, which one arrived first, ms from the first canary */
  canary: { sent: number; firstArrivedIdx: number; waitMs: number };
  teardownMs: number;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const code = (reason: string) => {
  const r = reason.replace(/^"|"$/g, "");
  const i = r.indexOf(":");
  return (i > 0 ? r.slice(0, i) : r).trim().slice(0, 60) || "empty";
};

export async function runBurst(spec: BurstSpec, pg: { query: Q }, log: (s: string) => void): Promise<BurstResult> {
  const socks: Sock[] = [];
  const chans: Chan[] = [];
  const byTopic = new Map<string, Chan>(); // `${sock}|${topic}`
  const byRef = new Map<string, Chan>();
  let refSeq = 1;
  // Canary rows (`<runTag>-c<k>`) inserted before the measured one: on a fresh
  // project the first change after a subscribe was not delivered (RUNLOG,
  // "Fresh-project warm-up"), and a fan-out that starts before the stream is
  // wired measures the wiring, not the fan-out.
  let firstCanaryAt = 0;
  let firstCanaryIdx = -1;
  const noteCanary = (body: unknown, now: number) => {
    const s = String(body ?? "");
    if (!firstCanaryAt && s.startsWith(`${spec.runTag}-c`)) {
      firstCanaryAt = now;
      firstCanaryIdx = Number(s.slice(spec.runTag.length + 2));
    }
  };
  const url = `wss://${spec.host}/realtime/v1/websocket?apikey=${spec.anon}&vsn=1.0.0`;

  const onMsg = (s: Sock, raw: string) => {
    let m: { topic?: string; event?: string; payload?: any; ref?: string | null };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    const ch = (m.ref && byRef.get(`${s.i}|${m.ref}`)) || byTopic.get(`${s.i}|${m.topic}`);
    if (!ch) return;
    switch (m.event) {
      case "phx_reply": {
        if (m.ref !== ch.ref || ch.replyAt) return;
        ch.replyAt = now;
        ch.replyText = JSON.stringify(m.payload).slice(0, 300);
        if (m.payload?.status === "ok") {
          if (spec.kind === "bc" && !ch.outcome) {
            ch.outcome = "ready";
            ch.readyAt = now;
          }
        } else if (!ch.outcome) {
          ch.outcome = `join_error:${code(String(m.payload?.response?.reason ?? m.payload?.response?.error ?? "none"))}`;
        }
        return;
      }
      case "system": {
        const p = m.payload ?? {};
        const msg = String(p.message ?? "").slice(0, 80);
        ch.replyText ||= JSON.stringify(p).slice(0, 300);
        if (p.extension === "postgres_changes") {
          if (p.status === "ok") {
            if (!ch.outcome) {
              ch.outcome = "ready";
              ch.readyAt = now;
            }
          } else if (!ch.outcome || ch.outcome === "ready") {
            ch.outcome = `pc_error:${msg}`;
            ch.replyText = JSON.stringify(p).slice(0, 300);
          }
        } else if (p.status === "error" && (!ch.outcome || ch.outcome === "ready")) {
          ch.outcome = `sys_error:${msg}`;
          ch.replyText = JSON.stringify(p).slice(0, 300);
        }
        return;
      }
      case "phx_close":
      case "phx_error":
        if (!ch.outcome) ch.outcome = `closed:${m.event}`;
        return;
      case "postgres_changes": {
        const body = m.payload?.data?.record?.body;
        if (body === spec.runTag && !ch.recvAt) ch.recvAt = now;
        else noteCanary(body, now);
        return;
      }
      case "broadcast": {
        const body = m.payload?.payload?.body;
        if (body === spec.runTag && !ch.recvAt) ch.recvAt = now;
        else noteCanary(body, now);
        return;
      }
    }
  };

  /* ---- open sockets, paced ---- */
  const openOne = (i: number) =>
    new Promise<Sock>((resolve) => {
      const s: Sock = { i, ws: null, open: false, openErr: "", closedWhy: "" };
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve(s);
        }
      };
      const timer = setTimeout(() => {
        s.openErr ||= "open_timeout";
        fin();
      }, 30_000);
      try {
        const ws = new WebSocket(url);
        s.ws = ws;
        ws.on("open", () => {
          s.open = true;
          clearTimeout(timer);
          s.hb = setInterval(() => {
            try {
              ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: `hb${refSeq++}` }));
            } catch {}
          }, 20_000);
          fin();
        });
        ws.on("message", (d) => onMsg(s, d.toString()));
        ws.on("error", (e) => {
          const t = (e instanceof Error ? e.message : String(e)).slice(0, 80);
          if (!s.open) s.openErr ||= `error:${t}`;
          else s.closedWhy ||= `error:${t}`;
          clearTimeout(timer);
          fin();
        });
        ws.on("close", (c, r) => {
          const why = `close:${c}${r?.length ? `:${r.toString().slice(0, 60)}` : ""}`;
          if (!s.open) s.openErr ||= why;
          else s.closedWhy ||= why;
          clearTimeout(timer);
          if (s.hb) clearInterval(s.hb);
          fin();
        });
      } catch (e) {
        s.openErr = `ctor:${String(e).slice(0, 60)}`;
        clearTimeout(timer);
        fin();
      }
    });

  const opening: Promise<Sock>[] = [];
  const gap = 1000 / Math.max(1, spec.connectRate);
  for (let i = 0; i < spec.sockets; i++) {
    opening.push(openOne(i));
    await sleep(gap);
  }
  socks.push(...(await Promise.all(opening)));
  const socketOpenFailures: Record<string, number> = {};
  for (const s of socks) if (!s.open) socketOpenFailures[s.openErr || "unknown"] = (socketOpenFailures[s.openErr || "unknown"] ?? 0) + 1;
  log(`[${spec.runTag}] sockets open ${socks.filter((s) => s.open).length}/${spec.sockets}`);

  /* ---- build channels, then the burst ---- */
  for (const s of socks) {
    for (let c = 0; c < spec.channelsPerSocket; c++) {
      const topic = spec.kind === "bc" ? `realtime:${spec.bcTopic}` : `realtime:${spec.runTag}:${s.i}:${c}`;
      const ref = String(refSeq++);
      const ch: Chan = { sock: s.i, topic, ref, joinSentAt: 0, replyAt: 0, readyAt: 0, outcome: "", replyText: "", recvAt: 0 };
      chans.push(ch);
      byTopic.set(`${s.i}|${topic}`, ch);
      byRef.set(`${s.i}|${ref}`, ch);
    }
  }
  const joinPayload = (token: string) =>
    spec.kind === "pc"
      ? {
          config: {
            broadcast: { ack: false, self: false },
            presence: { enabled: false },
            postgres_changes: [{ event: "INSERT", schema: "public", table: spec.table }],
            private: false,
          },
          access_token: token,
        }
      : {
          config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [], private: true },
          access_token: token,
        };
  const tBurst = Date.now();
  const perTick = spec.joinRate > 0 ? Math.max(1, Math.round(spec.joinRate / 20)) : Number.POSITIVE_INFINITY;
  let sentThisTick = 0;
  for (const ch of chans) {
    const s = socks[ch.sock]!;
    if (!s.open || !s.ws) {
      ch.outcome = `socket:${s.openErr || "not_open"}`;
      continue;
    }
    ch.joinSentAt = Date.now();
    try {
      s.ws.send(
        JSON.stringify({
          topic: ch.topic,
          event: "phx_join",
          payload: joinPayload(spec.tokens[ch.sock % spec.tokens.length]!),
          ref: ch.ref,
          join_ref: ch.ref,
        }),
      );
    } catch (e) {
      ch.outcome = `socket:send_failed`;
    }
    if (++sentThisTick >= perTick) {
      sentThisTick = 0;
      await sleep(50);
    }
  }
  const lastJoin = Date.now();

  /* ---- settle, sampling realtime's DB connections ---- */
  const dbConnMax: Record<string, number> = {};
  const settled = () => chans.every((c) => c.outcome !== "");
  while (Date.now() - lastJoin < spec.settleMs && !settled()) {
    try {
      const r = await pg.query(
        `select coalesce(usename,'?') || '/' || coalesce(nullif(application_name,''),'-') as k, count(*)::int as n
           from pg_stat_activity where usename ilike '%realtime%' or application_name ilike '%realtime%' group by 1`,
      );
      for (const row of r.rows as Array<{ k: string; n: number }>) dbConnMax[row.k] = Math.max(dbConnMax[row.k] ?? 0, row.n);
    } catch {}
    await sleep(1000);
  }
  for (const ch of chans) {
    const s = socks[ch.sock]!;
    if (ch.outcome) continue;
    if (s.closedWhy) ch.outcome = `socket:${s.closedWhy}`;
    else if (!ch.replyAt) ch.outcome = "no_reply";
    else ch.outcome = "no_system";
  }
  const burstWallMs = Date.now() - tBurst;
  let serverSubscriptions = -1;
  if (spec.kind === "pc") {
    try {
      serverSubscriptions = Number((await pg.query(`select count(*)::int as n from realtime.subscription`)).rows[0].n);
    } catch {}
  }

  /* ---- fan-out: one INSERT, arrival on every ready channel ---- */
  const ready = chans.filter((c) => c.outcome === "ready");
  let insertAckMs = -1;
  let ackAt = 0;
  let canaries = 0;
  let canaryWaitMs = -1;
  if (ready.length) {
    const tc = Date.now();
    let last = 0;
    while (!firstCanaryAt && Date.now() - tc < 60_000) {
      if (Date.now() - last >= 2000) {
        canaries++;
        last = Date.now();
        await pg
          .query(`insert into public.${spec.table} (tenant_id, body) values ($1, $2)`, [spec.tenantId, `${spec.runTag}-c${canaries}`])
          .catch(() => null);
      }
      await sleep(100);
    }
    canaryWaitMs = firstCanaryAt ? firstCanaryAt - tc : -1;
    await sleep(1000);
  }
  if (ready.length) {
    const t0 = Date.now();
    try {
      await pg.query(`insert into public.${spec.table} (tenant_id, body) values ($1, $2)`, [spec.tenantId, spec.runTag]);
      ackAt = Date.now();
      insertAckMs = ackAt - t0;
    } catch (e) {
      log(`[${spec.runTag}] fan-out insert failed: ${String(e).slice(0, 120)}`);
      ackAt = Date.now();
      insertAckMs = -2;
    }
    const end = Date.now() + 30_000;
    while (Date.now() < end && ready.some((c) => !c.recvAt)) await sleep(250);
  }
  const lat = ready.filter((c) => c.recvAt).map((c) => c.recvAt - ackAt);

  /* ---- teardown ---- */
  const tTear = Date.now();
  for (const s of socks) {
    if (s.hb) clearInterval(s.hb);
    try {
      s.ws?.close();
    } catch {}
  }
  let teardownMs = -1;
  if (spec.kind === "pc") {
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      try {
        const n = Number((await pg.query(`select count(*)::int as n from realtime.subscription`)).rows[0].n);
        if (n === 0) {
          teardownMs = Date.now() - tTear;
          break;
        }
      } catch {}
      await sleep(2000);
    }
  } else {
    await sleep(5000);
    teardownMs = Date.now() - tTear;
  }

  const outcomes: Record<string, number> = {};
  const samples: Record<string, string> = {};
  for (const c of chans) {
    outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    if (c.outcome !== "ready" && !samples[c.outcome]) samples[c.outcome] = c.replyText || "-";
  }
  const j2r = ready.map((c) => c.readyAt - c.joinSentAt);
  return {
    socketsOpened: socks.filter((s) => s.open).length,
    socketOpenFailures,
    channels: chans.length,
    ready: ready.length,
    outcomes,
    samples,
    joinToReadyP50: pct(j2r, 50),
    joinToReadyP95: pct(j2r, 95),
    joinToReadyMax: j2r.length ? Math.max(...j2r) : -1,
    burstWallMs,
    serverSubscriptions,
    dbConnMax,
    fanout: { delivered: lat.length, of: ready.length, p50: pct(lat, 50), p95: pct(lat, 95), max: lat.length ? Math.max(...lat) : -1, insertAckMs },
    canary: { sent: canaries, firstArrivedIdx: firstCanaryIdx, waitMs: canaryWaitMs },
    teardownMs,
  };
}
