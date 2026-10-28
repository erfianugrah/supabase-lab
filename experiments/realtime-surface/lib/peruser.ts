/**
 * Per-user raw-protocol fleet for RT06: one WebSocket per user, each with its
 * own access token and exactly one channel, so a join's topic, binding and
 * filter can differ per socket (lib/burst.ts gives every socket the same
 * binding and a shared token list). Phases are separate calls so a module can
 * open, join, then keep the fleet for a delivery or send phase:
 *
 *   openFleet  paced WebSocket opens (the connection rate is not measured)
 *   joinAll    every phx_join sent at once; each channel classified as in
 *              lib/burst.ts (ready / join_error:<code> / pc_error:<msg> /
 *              sys_error:<msg> / closed:<event> / socket:<why> / no_reply /
 *              no_system), with a hook called once a second while it settles
 *   closeFleet close every socket
 *
 * Every postgres_changes record body and every broadcast payload `k` a client
 * receives is kept with its arrival time (Date.now(), the same clock the
 * module stamps sends with), so deliveries can be counted per client.
 */
import WebSocket from "ws";
import { sleep } from "./rt";

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return -1;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const code = (reason: string) => {
  const r = reason.replace(/^"|"$/g, "");
  const i = r.indexOf(":");
  return (i > 0 ? r.slice(0, i) : r).trim().slice(0, 60) || "empty";
};

export interface Cli {
  i: number;
  ws: WebSocket | null;
  open: boolean;
  openErr: string;
  closedWhy: string;
  hb?: ReturnType<typeof setInterval>;
  kind: "pc" | "bc";
  topic: string;
  ref: string;
  joinSentAt: number;
  replyAt: number;
  readyAt: number;
  /** when the outcome was first set (ready or a failure) */
  settledAt: number;
  outcome: string;
  replyText: string;
  /** system errors and closes that arrived after the channel was ready */
  late: string[];
  /** received key -> first arrival time */
  got: Map<string, number>;
  dup: number;
}

export async function openFleet(host: string, anon: string, n: number, rate: number, log: (s: string) => void, tag: string): Promise<Cli[]> {
  const url = `wss://${host}/realtime/v1/websocket?apikey=${anon}&vsn=1.0.0`;
  let hbSeq = 1;
  const openOne = (i: number) =>
    new Promise<Cli>((resolve) => {
      const c: Cli = {
        i, ws: null, open: false, openErr: "", closedWhy: "", kind: "pc", topic: "", ref: "",
        joinSentAt: 0, replyAt: 0, readyAt: 0, settledAt: 0, outcome: "", replyText: "", late: [], got: new Map(), dup: 0,
      };
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve(c);
        }
      };
      const timer = setTimeout(() => {
        c.openErr ||= "open_timeout";
        fin();
      }, 30_000);
      try {
        const ws = new WebSocket(url);
        c.ws = ws;
        ws.on("open", () => {
          c.open = true;
          clearTimeout(timer);
          c.hb = setInterval(() => {
            try {
              ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: `hb${hbSeq++}` }));
            } catch {}
          }, 20_000);
          fin();
        });
        ws.on("message", (d) => onMsg(c, d.toString()));
        ws.on("error", (e) => {
          const t = (e instanceof Error ? e.message : String(e)).slice(0, 80);
          if (!c.open) c.openErr ||= `error:${t}`;
          else c.closedWhy ||= `error:${t}`;
          clearTimeout(timer);
          fin();
        });
        ws.on("close", (code, r) => {
          const why = `close:${code}${r?.length ? `:${r.toString().slice(0, 60)}` : ""}`;
          if (!c.open) c.openErr ||= why;
          else c.closedWhy ||= why;
          clearTimeout(timer);
          if (c.hb) clearInterval(c.hb);
          fin();
        });
      } catch (e) {
        c.openErr = `ctor:${String(e).slice(0, 60)}`;
        clearTimeout(timer);
        fin();
      }
    });
  const opening: Promise<Cli>[] = [];
  const gap = 1000 / Math.max(1, rate);
  for (let i = 0; i < n; i++) {
    opening.push(openOne(i));
    await sleep(gap);
  }
  const clis = await Promise.all(opening);
  log(`[${tag}] sockets open ${clis.filter((c) => c.open).length}/${n}`);
  return clis;
}

function settle(c: Cli, outcome: string, now: number) {
  c.outcome = outcome;
  c.settledAt = now;
  if (outcome === "ready") c.readyAt = now;
}

function onMsg(c: Cli, raw: string) {
  let m: { topic?: string; event?: string; payload?: any; ref?: string | null };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.topic !== c.topic) return;
  const now = Date.now();
  switch (m.event) {
    case "phx_reply": {
      if (m.ref !== c.ref || c.replyAt) return;
      c.replyAt = now;
      c.replyText = JSON.stringify(m.payload).slice(0, 300);
      if (m.payload?.status === "ok") {
        if (c.kind === "bc" && !c.outcome) settle(c, "ready", now);
      } else if (!c.outcome) {
        settle(c, `join_error:${code(String(m.payload?.response?.reason ?? m.payload?.response?.error ?? "none"))}`, now);
      }
      return;
    }
    case "system": {
      const p = m.payload ?? {};
      const msg = String(p.message ?? "").slice(0, 80);
      if (p.extension === "postgres_changes" && p.status === "ok") {
        if (!c.outcome) settle(c, "ready", now);
        return;
      }
      if (p.status === "error" || p.extension === "postgres_changes") {
        const o = p.extension === "postgres_changes" ? `pc_error:${msg}` : `sys_error:${msg}`;
        if (!c.outcome) {
          settle(c, o, now);
          c.replyText = JSON.stringify(p).slice(0, 300);
        } else if (c.outcome === "ready") c.late.push(o);
      }
      return;
    }
    case "phx_close":
    case "phx_error":
      if (!c.outcome) settle(c, `closed:${m.event}`, now);
      else if (c.outcome === "ready") c.late.push(`closed:${m.event}`);
      return;
    case "postgres_changes": {
      const key = String(m.payload?.data?.record?.body ?? "");
      if (!key) return;
      if (c.got.has(key)) c.dup++;
      else c.got.set(key, now);
      return;
    }
    case "broadcast": {
      const key = String(m.payload?.payload?.k ?? "");
      if (!key) return;
      if (c.got.has(key)) c.dup++;
      else c.got.set(key, now);
      return;
    }
  }
}

export interface JoinSpec {
  kind: "pc" | "bc";
  topic: string;
  token: string;
  /** pc only: the one binding's filter, e.g. `user_id=eq.<uuid>`; omitted = unfiltered */
  filter?: string;
}

export interface JoinSummary {
  channels: number;
  ready: number;
  outcomes: Record<string, number>;
  samples: Record<string, string>;
  j2rP50: number;
  j2rP95: number;
  j2rMax: number;
  /** first join sent -> last channel settled (any outcome), within the settle window */
  allSettledMs: number;
  /** first join sent -> last channel ready; -1 unless every channel is ready */
  allReadyMs: number;
  firstJoinAt: number;
  lastJoinAt: number;
}

export async function joinAll(
  clis: Cli[],
  spec: (i: number) => JoinSpec,
  table: string,
  settleMs: number,
  onTick: () => Promise<void>,
): Promise<JoinSummary> {
  let ref = 1;
  for (const c of clis) {
    const s = spec(c.i);
    c.kind = s.kind;
    c.topic = `realtime:${s.topic}`;
    c.ref = `j${ref++}`;
  }
  const first = Date.now();
  for (const c of clis) {
    const s = spec(c.i);
    if (!c.open || !c.ws) {
      settle(c, `socket:${c.openErr || "not_open"}`, Date.now());
      continue;
    }
    const binding: Record<string, string> = { event: "INSERT", schema: "public", table };
    if (s.filter) binding.filter = s.filter;
    const payload =
      s.kind === "pc"
        ? { config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [binding], private: false }, access_token: s.token }
        : { config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [], private: true }, access_token: s.token };
    c.joinSentAt = Date.now();
    try {
      c.ws.send(JSON.stringify({ topic: c.topic, event: "phx_join", payload, ref: c.ref, join_ref: c.ref }));
    } catch {
      settle(c, "socket:send_failed", Date.now());
    }
  }
  const last = Date.now();
  while (Date.now() - last < settleMs && !clis.every((c) => c.outcome !== "")) {
    await onTick().catch(() => {});
    await sleep(1000);
  }
  for (const c of clis) {
    if (c.outcome) continue;
    if (c.closedWhy) c.outcome = `socket:${c.closedWhy}`;
    else if (!c.replyAt) c.outcome = "no_reply";
    else c.outcome = "no_system";
  }
  const outcomes: Record<string, number> = {};
  const samples: Record<string, string> = {};
  for (const c of clis) {
    outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    if (c.outcome !== "ready" && !samples[c.outcome]) samples[c.outcome] = c.replyText || "-";
  }
  const ready = clis.filter((c) => c.outcome === "ready");
  const j2r = ready.map((c) => c.readyAt - c.joinSentAt);
  const settledTimes = clis.filter((c) => c.settledAt).map((c) => c.settledAt);
  return {
    channels: clis.length,
    ready: ready.length,
    outcomes,
    samples,
    j2rP50: pct(j2r, 50),
    j2rP95: pct(j2r, 95),
    j2rMax: j2r.length ? Math.max(...j2r) : -1,
    allSettledMs: settledTimes.length ? Math.max(...settledTimes) - first : -1,
    allReadyMs: ready.length === clis.length && ready.length ? Math.max(...ready.map((c) => c.readyAt)) - first : -1,
    firstJoinAt: first,
    lastJoinAt: last,
  };
}

export function closeFleet(clis: Cli[]) {
  for (const c of clis) {
    if (c.hb) clearInterval(c.hb);
    try {
      c.ws?.close();
    } catch {}
  }
}
