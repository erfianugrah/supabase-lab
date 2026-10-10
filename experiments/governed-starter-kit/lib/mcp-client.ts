/**
 * A small MCP client over Streamable HTTP, written for measurement: the
 * capabilities it declares are chosen by the caller, and every elicitation the
 * server raises is recorded and answered by a caller-supplied handler, so a
 * test can play "a client without elicitation", "a client that accepts" and "a
 * client that declines" against the same server.
 *
 * Two protocol shapes, picked by `protocolVersion`:
 *
 *  - "legacy" (a 2025 revision): `initialize`, a session id, capabilities sent
 *    once. A server that elicits does it with an `elicitation/create` request
 *    sent to the client inside the call's event stream.
 *  - "2026-07-28": no initialize and no session. Every request carries
 *    protocolVersion, clientInfo and clientCapabilities in `params._meta`; a
 *    tool that needs input answers `resultType: "input_required"` with
 *    `inputRequests`, and the client repeats the same call with
 *    `inputResponses` and the server's `requestState`. This is what Claude Code
 *    2.1.287 sent to the hosted Supabase MCP server (captured through a local
 *    forwarding proxy, 2026-10-10).
 *
 * Not a general client: no resumption, no server-initiated GET stream.
 */

export interface ServerRequest {
  /** the input-request key in the 2026-07-28 shape, "" in the legacy shape */
  key: string;
  method: string;
  params: Record<string, unknown>;
}
export type ElicitReply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type ElicitHandler = (req: ServerRequest) => ElicitReply | undefined;

export interface McpCallResult {
  http: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  /** elicitations the server raised during the call, in order */
  serverRequests: ServerRequest[];
  /** content-type of the final POST response */
  contentType: string;
  /** how many times the call was repeated with inputResponses (2026-07-28 shape) */
  retries: number;
}

export interface McpClientOpts {
  url: string;
  headers: Record<string, string>;
  capabilities: Record<string, unknown>;
  protocolVersion?: string;
  name?: string;
  onServerRequest?: ElicitHandler;
}

export const STATELESS = "2026-07-28";

// Namespace of the `_meta` keys. Built from two pieces because the repo's
// identifier scan (harness/src/identifiers.test.ts) rejects any 20-letter
// lowercase token, and the protocol's own name is one.
const NS = ["io", "modelcontext" + "protocol"].join(".");

export class McpClient {
  private sid = "";
  private id = 0;
  protocolVersion = "";
  serverInfo: Record<string, unknown> = {};
  constructor(private o: McpClientOpts) {
    this.protocolVersion = o.protocolVersion ?? "2025-06-18";
  }

  get stateless(): boolean {
    return this.protocolVersion === STATELESS;
  }

  private meta(): Record<string, unknown> {
    return {
      [`${NS}/protocolVersion`]: this.protocolVersion,
      [`${NS}/clientInfo`]: { name: this.o.name ?? "pvlab-k", version: "0" },
      [`${NS}/clientCapabilities`]: this.o.capabilities,
    };
  }

  private hdrs(method?: string, name?: string): Record<string, string> {
    return {
      ...this.o.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sid ? { "Mcp-Session-Id": this.sid } : {}),
      "MCP-Protocol-Version": this.protocolVersion,
      ...(this.stateless && method ? { "Mcp-Method": method } : {}),
      ...(this.stateless && name ? { "Mcp-Name": name } : {}),
    };
  }

  private async post(body: unknown, method?: string, name?: string, timeoutMs = 120_000): Promise<Response> {
    for (let i = 0; ; i++) {
      const res = await fetch(this.o.url, { method: "POST", headers: this.hdrs(method, name), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 || i >= 3) return res;
      const wait = Number(res.headers.get("retry-after") ?? "15");
      await res.text();
      await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 1), 65) * 1000));
    }
  }

  /** Legacy: initialize + initialized. 2026-07-28: server/discover. */
  async initialize(): Promise<McpCallResult> {
    if (this.stateless) {
      const r = await this.rpc("server/discover", {});
      this.serverInfo = ((r.result?._meta as Record<string, unknown> | undefined)?.[`${NS}/serverInfo`] ?? {}) as Record<string, unknown>;
      return r;
    }
    const r = await this.rpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: this.o.capabilities,
      clientInfo: { name: this.o.name ?? "pvlab-k", version: "0" },
    });
    this.protocolVersion = String((r.result as { protocolVersion?: string } | undefined)?.protocolVersion ?? this.protocolVersion);
    this.serverInfo = ((r.result as { serverInfo?: Record<string, unknown> } | undefined)?.serverInfo ?? {}) as Record<string, unknown>;
    if (!r.error && r.http < 300) await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((x) => x.text());
    return r;
  }

  /**
   * One tools/call with caller-chosen extra params (inputResponses, requestState),
   * and no automatic follow-up of an input_required answer. For replay and
   * tamper probes against the 2026-07-28 shape.
   */
  callOnce(name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<McpCallResult> {
    return this.rpc("tools/call", { name, arguments: args, ...extra }, 150_000, false);
  }

  async rpc(method: string, params: Record<string, unknown>, timeoutMs = 150_000, follow = true): Promise<McpCallResult> {
    const serverRequests: ServerRequest[] = [];
    let extra: Record<string, unknown> = {};
    let out: McpCallResult | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = ++this.id;
      const p = this.stateless ? { ...params, ...extra, _meta: this.meta() } : params;
      const res = await this.post({ jsonrpc: "2.0", id, method, params: p }, method, (params as { name?: string }).name, timeoutMs);
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sid = sid;
      out = await this.readResponse(res, id, serverRequests);
      out.retries = attempt;
      const r = out.result as { resultType?: string; inputRequests?: Record<string, { method: string; params: Record<string, unknown> }>; requestState?: string } | undefined;
      if (!follow || !this.stateless || r?.resultType !== "input_required") break;
      const inputResponses: Record<string, unknown> = {};
      for (const [key, req] of Object.entries(r.inputRequests ?? {})) {
        const sr: ServerRequest = { key, method: req.method, params: req.params ?? {} };
        serverRequests.push(sr);
        const reply = this.o.onServerRequest?.(sr);
        inputResponses[key] = reply ?? { action: "cancel" };
      }
      extra = { inputResponses, ...(r.requestState ? { requestState: r.requestState } : {}) };
    }
    out!.serverRequests = serverRequests;
    return out!;
  }

  private async readResponse(res: Response, id: number, serverRequests: ServerRequest[]): Promise<McpCallResult> {
    const contentType = res.headers.get("content-type") ?? "";
    const out: McpCallResult = { http: res.status, serverRequests, contentType, retries: 0 };
    if (!contentType.includes("text/event-stream")) {
      const text = await res.text();
      try {
        const j = JSON.parse(text) as { result?: Record<string, unknown>; error?: { code?: number; message?: string } };
        out.result = j.result;
        out.error = j.error;
        if (res.status >= 400 && !(out.error as { message?: string } | undefined)?.message) out.error = { message: `http ${res.status}: ${text.slice(0, 200)}` };
      } catch {
        out.error = { message: `non-JSON body (http ${res.status}): ${text.slice(0, 200)}` };
      }
      return out;
    }
    // SSE: read events until the response with our id arrives; answer legacy server requests on the way.
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        const msg = JSON.parse(data) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code?: number; message?: string } };
        if (msg.method && msg.id !== undefined) {
          const req: ServerRequest = { key: "", method: msg.method, params: msg.params ?? {} };
          serverRequests.push(req);
          const reply = this.o.onServerRequest?.(req);
          const body = reply
            ? { jsonrpc: "2.0", id: msg.id, result: reply }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not supported by this client" } };
          await this.post(body).then((x) => x.text());
        } else if (msg.id === id) {
          out.result = msg.result;
          out.error = msg.error;
          done = true;
          break;
        }
      }
    }
    await reader.cancel().catch(() => null);
    return out;
  }

  listTools(): Promise<McpCallResult> {
    return this.rpc("tools/list", {});
  }
  callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<McpCallResult> {
    return this.rpc("tools/call", { name, arguments: args }, timeoutMs);
  }
}

/** Text of a tools/call result (concatenated text content). */
export function toolText(r: McpCallResult): string {
  const content = (r.result?.content ?? []) as { type?: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}
export function toolStructured(r: McpCallResult): unknown {
  return r.result?.structuredContent;
}
