/**
 * T16 - Realtime from inside the VPC.
 *
 * The bash version hand-rolled a WebSocket upgrade with curl and got an
 * uninterpretable 500. A real client either completes the handshake or fails
 * with a reason, which is the whole point of porting this.
 *
 * Expectation under test: Realtime is an HTTP/WS service on the API hostname,
 * NOT carried by PrivateLink, so it works from in-VPC only via public egress.
 */
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { TestModule, TestResult } from "../../../harness/src/types";

function connect(url: string, timeoutMs = 15000): Promise<TestResult["measurements"]> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`handshake timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    ws.on("open", () =>
      done(() => resolve({ handshake_ms: Math.round(performance.now() - t0) })),
    );
    ws.on("unexpected-response", (_req: unknown, res: IncomingMessage) =>
      done(() => reject(new Error(`HTTP ${res.statusCode} on upgrade`))),
    );
    ws.on("error", (e: Error) => done(() => reject(e)));
  });
}

const mod: TestModule = {
  id: "T16",
  title: "Realtime WebSocket from in-VPC (public path, by design)",
  where: "runner",
  requires: ["anon-key"],
  async run(ctx) {
    const url = `wss://${ctx.apiHost}/realtime/v1/websocket?apikey=${ctx.anonKey}&vsn=1.0.0`;
    try {
      const m = await connect(url);
      return {
        id: "T16",
        title: "Realtime WebSocket from in-VPC",
        status: "pass",
        detail: `handshake completed against ${ctx.apiHost} (egress via NAT, not the endpoint)`,
        measurements: m,
      };
    } catch (e) {
      return {
        id: "T16",
        title: "Realtime WebSocket from in-VPC",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
        evidence: url.replace(ctx.anonKey ?? "", "<anon-key>"),
      };
    }
  },
};
export default mod;
