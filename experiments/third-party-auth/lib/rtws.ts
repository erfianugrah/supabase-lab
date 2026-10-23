/**
 * A raw Realtime socket for TPA06: Phoenix protocol vsn 1.0.0 (JSON object
 * frames), every inbound frame kept verbatim with its arrival time, so a
 * module can quote what Realtime itself answered to a join, an access_token
 * push or an expiring token. No supabase-js client: its channel object
 * retries joins and swallows `system` frames, and the point here is the
 * server's reply text. Protocol shape:
 * https://supabase.com/docs/guides/realtime/protocol (as realtime-surface RT03d
 * and lib/burst.ts use it).
 */

export interface Frame {
  at: number;
  topic: string;
  event: string;
  payload: any;
  ref: string | null;
}

export interface JoinReply {
  status: string;
  /** reason text for an error reply, or the postgres_changes ids summary for ok */
  detail: string;
  raw: string;
}

export class RtSock {
  frames: Frame[] = [];
  closedWhy = "";
  private ws: WebSocket | null = null;
  private seq = 1;
  private hb?: ReturnType<typeof setInterval>;

  constructor(
    private host: string,
    private apikey: string,
  ) {}

  open(timeoutMs = 15_000): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`wss://${this.host}/realtime/v1/websocket?apikey=${this.apikey}&vsn=1.0.0`);
      this.ws = ws;
      const t = setTimeout(() => resolve(false), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        this.hb = setInterval(() => this.push("phoenix", "heartbeat", {}), 25_000);
        resolve(true);
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          const m = JSON.parse(raw) as Omit<Frame, "at">;
          this.frames.push({ at: Date.now(), topic: m.topic, event: m.event, payload: m.payload, ref: m.ref ?? null });
        } catch {
          /* non-JSON frame: ignore */
        }
      });
      ws.addEventListener("close", (ev: CloseEvent) => {
        this.closedWhy = `close ${ev.code} ${ev.reason}`.trim();
        clearTimeout(t);
        resolve(false);
      });
      ws.addEventListener("error", () => {
        if (!this.closedWhy) this.closedWhy = "ws error";
      });
    });
  }

  push(topic: string, event: string, payload: unknown, joinRef?: string): string {
    const ref = String(this.seq++);
    this.ws?.send(JSON.stringify({ topic, event, payload, ref, join_ref: joinRef ?? null }));
    return ref;
  }

  /** phx_join and wait for its phx_reply. `token` undefined = no access_token (anon). */
  async join(
    topic: string,
    config: { private: boolean; postgres_changes?: unknown[]; broadcast?: Record<string, unknown> },
    token?: string,
    timeoutMs = 15_000,
  ): Promise<JoinReply & { joinRef: string }> {
    const payload: Record<string, unknown> = {
      config: { broadcast: config.broadcast ?? { self: false, ack: false }, presence: { key: "", enabled: false }, postgres_changes: config.postgres_changes ?? [], private: config.private },
    };
    if (token !== undefined) payload.access_token = token;
    const joinRef = this.push(`realtime:${topic}`, "phx_join", payload);
    const r = await this.reply(joinRef, timeoutMs);
    return { ...r, joinRef };
  }

  async reply(ref: string, timeoutMs = 15_000): Promise<JoinReply> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const f = this.frames.find((x) => x.event === "phx_reply" && x.ref === ref);
      if (f) {
        const status = String(f.payload?.status ?? "");
        const resp = f.payload?.response ?? {};
        const detail = status === "ok" ? `pc=${Array.isArray(resp.postgres_changes) ? resp.postgres_changes.length : 0}` : String(resp.reason ?? JSON.stringify(resp)).slice(0, 300);
        return { status, detail, raw: JSON.stringify(f.payload).slice(0, 400) };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { status: "no_reply", detail: this.closedWhy || "no phx_reply in window", raw: "" };
  }

  /** frames for one channel topic (without the `realtime:` prefix) after `since`. */
  on(topic: string, event?: string, since = 0): Frame[] {
    return this.frames.filter((f) => f.topic === `realtime:${topic}` && f.at >= since && (!event || f.event === event));
  }

  close(): void {
    if (this.hb) clearInterval(this.hb);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Verbatim-ish summary of a frame for evidence: event, then the payload's message/status/reason. */
export function frameText(f: Frame): string {
  const p = f.payload ?? {};
  const bits = [p.status, p.extension, p.message, p.reason, p.response?.reason].filter((x) => x !== undefined && x !== "");
  return `${f.event}${bits.length ? ` ${JSON.stringify(bits)}` : ""}`.slice(0, 240);
}
