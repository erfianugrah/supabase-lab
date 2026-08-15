/**
 * W12 - realtime probe (connect, subscribe, event latency, reconnect)
 *
 * Measures the latency of real-time event delivery via WebSockets and
 * ensures connectivity and event delivery persist through reconnections.
 *
 * Hard-won mechanics (do not regress):
 * - Do NOT drop/recreate the table; it wedges the realtime publication.
 *   Clean up rows only.
 * - WebSocket connection must use apikey and vsn=1.0.0.
 * - The phx_join payload must specify the postgres_changes configuration.
 * - Use the project's publishable key (ctx.anonKey) for the apikey parameter.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W12",
  title: "realtime probe (connect, subscribe, event latency, reconnect)",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const measurements: Record<string, string | number> = {};
    const apiHost = ctx.apiHost;
    const anonKey = ctx.anonKey!;
    const ref = ctx.ref;

    // runSql: verbatim error capture.
    const runSql = async (query: string) => {
      const res = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
      if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
      return res;
    };

    const cleanup = async () => {
      try {
        await runSql(`DELETE FROM public.probe_canary`);
      } catch (e) {
        ctx.log(`WARN: cleanup delete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const performProbe = async (connectionId: string): Promise<number> => {
      const url = `wss://${apiHost}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;
      const ws = new WebSocket(url);
      let insertTimestamp: number | undefined;
      let eventTimestamp: number | undefined;
      let errorMsg: string | undefined;

      return new Promise<number>((resolve, reject) => {
        ws.onopen = async () => {
          try {
            const joinPayload = {
              topic: "realtime:public:probe_canary",
              event: "phx_join",
              payload: {
                config: {
                  postgres_changes: [{ event: "INSERT", schema: "public", table: "probe_canary" }],
                },
              },
              ref: "1",
            };
            ws.send(JSON.stringify(joinPayload));
          } catch (e: any) {
            reject(e);
          }
        };

        ws.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.event === "phx_reply" && msg.payload?.status === "ok") {
              // Connection established, now trigger the insert
              insertTimestamp = Date.now();
              const insertRes = await fetch(`https://${apiHost}/rest/v1/probe_canary`, {
                method: "POST",
                headers: {
                  "apikey": anonKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ payload: `probe-${connectionId}` }),
              });
              if (!insertRes.ok) throw new Error(`Insert failed: HTTP ${insertRes.status}`);
            } else if (msg.event === "postgres_changes") {
              eventTimestamp = Date.now();
              ws.close();
              if (insertTimestamp && eventTimestamp) {
                resolve(eventTimestamp - insertTimestamp);
              } else {
                reject(new Error("Event received before insert was triggered"));
              }
            } else if (msg.event === "error") {
              errorMsg = msg.payload?.message;
              reject(new Error(errorMsg));
            }
          } catch (e: any) {
            reject(e);
          }
        };

        ws.onerror = (e) => {
          errorMsg = "WebSocket error";
          reject(new Error(errorMsg));
        };

        ws.onclose = () => {
          if (!eventTimestamp) reject(new Error("Connection closed before event received"));
        };
      });
    };

    try {
      // 1. Ensure table exists and is in publication.
      await runSql(`CREATE TABLE IF NOT EXISTS public.probe_canary (id serial primary key, payload text)`);
      await runSql(`DROP PUBLICATION IF EXISTS supabase_realtime`);
      await runSql(`CREATE PUBLICATION supabase_realtime FOR TABLE public.probe_canary`);
      measurements["publication_setup"] = "true";

      // 2. Connection 1
      // Battery-context flake (2026-08-15): a join right after 11 other
      // modules can have the socket closed by the server before the event
      // arrives - realtime subscription warm-up under load. Retry the whole
      // probe with backoff; standalone runs pass first try.
      const probeWithRetry = async (id: string): Promise<number> => {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            const ms = await performProbe(id);
            if (attempt > 1) measurements[`retry_used_${id}`] = attempt;
            return ms;
          } catch (e) {
            lastErr = e;
            measurements[`attempt_${id}_${attempt}_error`] = e instanceof Error ? e.message : String(e);
            await new Promise((r) => setTimeout(r, attempt * 3000));
          }
        }
        throw lastErr;
      };
      const latency1 = await probeWithRetry("1");
      measurements["connection1_ms"] = latency1;

      // 3. Connection 2 (reconnect)
      const latency2 = await probeWithRetry("2");
      measurements["connection2_ms"] = latency2;

      return {
        id: "W12",
        title: this.title,
        status: "pass",
        detail: `realtime probe successful: conn1=${latency1}ms, conn2=${latency2}ms`,
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W12",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};
export default mod;
