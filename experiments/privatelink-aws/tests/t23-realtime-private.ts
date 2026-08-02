/**
 * T23 - flip Realtime to private-channels-only and measure what an anon
 * client can still do.
 *
 * The docs give the posture ("To enforce private channels you need to disable
 * the 'Allow public access' setting in Realtime Settings" -
 * /docs/supabase/guides/realtime/authorization.md) and the Management API has
 * the matching lever: PATCH /v1/projects/{ref}/config/realtime { private_only }.
 * What is NOT documented is where the enforcement lands. Two candidates, and
 * they mean very different things for a locked-down design:
 *
 *   - at the WebSocket upgrade: the socket never opens, so nothing anonymous
 *     reaches Realtime at all;
 *   - at channel join: the socket opens fine and the phx_join reply carries
 *     the refusal.
 *
 * T16 already establishes that the handshake succeeds over public egress in
 * the default configuration, so this test measures the delta, and records the
 * refusal verbatim rather than paraphrasing it.
 *
 * DESTRUCTIVE: mutates project configuration; restores the baseline value of
 * private_only in a finally block.
 */
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const MGMT = "https://api.supabase.com";
const POLL_MS = 5000;
const MAX_WAIT_MS = 120_000;
const TOPIC = "realtime:pvlab-probe";

interface JoinOutcome {
  /** Did the WS upgrade complete? */
  handshake: boolean;
  handshakeMs: number;
  /** phx_reply status for a PUBLIC channel join: "ok" | "error" | "none". */
  joinStatus: string;
  /** Verbatim reply payload or transport error. */
  detail: string;
}

/**
 * Open a socket and attempt to join a NON-private channel with the anon key.
 * That is exactly the operation private_only is supposed to refuse.
 */
function joinPublicChannel(ctx: Ctx, timeoutMs = 20000): Promise<JoinOutcome> {
  return new Promise((resolve) => {
    const url = `wss://${ctx.apiHost}/realtime/v1/websocket?apikey=${ctx.anonKey}&vsn=1.0.0`;
    const t0 = performance.now();
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    let handshake = false;
    let handshakeMs = 0;

    const finish = (o: Omit<JoinOutcome, "handshake" | "handshakeMs">) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve({ handshake, handshakeMs, ...o });
    };
    const timer = setTimeout(
      () => finish({ joinStatus: "none", detail: `no phx_reply within ${timeoutMs}ms` }),
      timeoutMs,
    );

    ws.on("open", () => {
      handshake = true;
      handshakeMs = Math.round(performance.now() - t0);
      ws.send(
        JSON.stringify({
          topic: TOPIC,
          event: "phx_join",
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: "" },
              private: false,
            },
          },
          ref: "1",
        }),
      );
    });

    ws.on("message", (raw: Buffer | string) => {
      const text = raw.toString();
      let msg: { event?: string; payload?: { status?: string } } | undefined;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.event !== "phx_reply" && msg?.event !== "phx_error") return;
      finish({ joinStatus: msg.payload?.status ?? msg.event, detail: text.slice(0, 400) });
    });

    ws.on("unexpected-response", (_req: unknown, res: IncomingMessage) =>
      finish({ joinStatus: "upgrade-refused", detail: `HTTP ${res.statusCode} on upgrade` }),
    );
    ws.on("error", (e: Error) => finish({ joinStatus: "error", detail: e.message }));
  });
}

async function mgmt(ctx: Ctx, method: string, path: string, body?: unknown) {
  const res = await fetch(`${MGMT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.pat}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, text, json };
}

const mod: TestModule = {
  id: "T23",
  title: "Realtime private_only: where the refusal lands",
  where: "runner",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx) {
    const results: TestResult[] = [];

    const before = await mgmt(ctx, "GET", `/v1/projects/${ctx.ref}/config/realtime`);
    if (!before.ok) {
      return {
        id: "T23a",
        title: "read the Realtime config",
        status: "fail",
        detail: `GET /v1/projects/{ref}/config/realtime returned HTTP ${before.status}`,
        evidence: before.text.slice(0, 300),
      };
    }
    const baselinePrivateOnly = Boolean((before.json as { private_only?: boolean }).private_only);
    ctx.log(`baseline private_only = ${baselinePrivateOnly}`);

    const open = await joinPublicChannel(ctx);
    results.push({
      id: "T23a",
      title: "public channel join, baseline config",
      status: open.joinStatus === "ok" ? "pass" : "info",
      detail: `handshake ${open.handshake ? "ok" : "failed"}, join status "${open.joinStatus}" (private_only=${baselinePrivateOnly})`,
      measurements: {
        handshake_ms: open.handshakeMs,
        join_status: open.joinStatus,
        private_only: String(baselinePrivateOnly),
      },
      evidence: open.detail,
    });

    const flip = await mgmt(ctx, "PATCH", `/v1/projects/${ctx.ref}/config/realtime`, {
      private_only: true,
    });
    results.push({
      id: "T23b",
      title: "PATCH private_only=true",
      status: flip.ok ? "pass" : "fail",
      detail: flip.ok
        ? "Management API accepts the lever - this posture IS expressible without the Dashboard"
        : `HTTP ${flip.status}`,
      measurements: { patch_status: flip.status },
      evidence: flip.ok ? undefined : flip.text.slice(0, 300),
    });

    if (!flip.ok) return results;

    try {
      // Config propagation is not instant; poll for the behaviour change so a
      // fast probe cannot record a false "no effect".
      const t0 = Date.now();
      let attempt = await joinPublicChannel(ctx);
      while (Date.now() - t0 < MAX_WAIT_MS && attempt.joinStatus === "ok") {
        ctx.log(`still joining public channels after ${Math.round((Date.now() - t0) / 1000)}s`);
        await Bun.sleep(POLL_MS);
        attempt = await joinPublicChannel(ctx);
      }
      const seconds = Math.round((Date.now() - t0) / 1000);
      const refused = attempt.joinStatus !== "ok";

      results.push({
        id: "T23c",
        title: "public channel join with private_only=true",
        status: refused ? "pass" : "fail",
        detail: refused
          ? `refused after ${seconds}s: handshake ${attempt.handshake ? "STILL SUCCEEDS" : "refused at upgrade"}, join status "${attempt.joinStatus}"`
          : `still joined a public channel ${seconds}s after the flip`,
        measurements: {
          time_to_effect_s: refused ? seconds : "no effect",
          handshake: attempt.handshake ? "ok" : "refused",
          join_status: attempt.joinStatus,
        },
        evidence: attempt.detail,
      });

      results.push({
        id: "T23d",
        title: "where private_only is enforced",
        status: "info",
        detail: !refused
          ? "no enforcement observed on an anon public-channel join"
          : attempt.handshake
            ? "at channel join - the anon WebSocket still connects, so Realtime remains an internet-reachable surface; private_only narrows what a connected client may do, it does not remove the endpoint"
            : "at the WebSocket upgrade - anon clients cannot reach Realtime at all",
        measurements: { enforcement_point: !refused ? "none" : attempt.handshake ? "channel-join" : "ws-upgrade" },
      });
    } finally {
      const restore = await mgmt(ctx, "PATCH", `/v1/projects/${ctx.ref}/config/realtime`, {
        private_only: baselinePrivateOnly,
      });
      results.push({
        id: "T23e",
        title: "restore private_only",
        status: restore.ok ? "pass" : "fail",
        detail: restore.ok
          ? `private_only restored to ${baselinePrivateOnly}`
          : `restore PATCH returned HTTP ${restore.status} - PROJECT LEFT WITH private_only=true`,
        measurements: { restore_status: restore.status },
      });
    }

    return results;
  },
};
export default mod;
