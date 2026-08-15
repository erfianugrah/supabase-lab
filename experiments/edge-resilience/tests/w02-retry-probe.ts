
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { createClient } from "@supabase/supabase-js";

export default {
  id: "W02",
  title: "W02 - supabase-js retry behaviour under JWT rejection vs 5xx",
  where: "local" as const,
  requires: [],
  async run(ctx: Ctx): Promise<TestResult> {
    let requests = 0;
    let server: any = null;
    let port = 0;

    const cleanup = async () => {
      if (server) {
        server.close();
      }
    };

    const startServer = (behavior: (req: any) => Promise<Response>) => {
      return new Promise<number>((resolve) => {
        server = Bun.serve({
          port: 0,
          async fetch(req) {
            requests++;
            return behavior(req);
          },
        });
        resolve(server.server!.port);
      });
    };

    const measurements: Record<string, number | string> = {
      "supabase-js-version": "v2.102.0", // From package.json as instructed
    };

    try {
      // Case A: 401 PGRST303
      requests = 0;
      port = await startServer(async () => {
        return new Response(JSON.stringify({ code: "PGRST303" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      });
      const url = `http://127.0.0.1:${port}/rest/v1/t`;
      const clientA = createClient(url, "anon-key");
      const startA = Date.now();
      await clientA.from("t").select("*").execute();
      measurements["caseA-attempts"] = requests;
      measurements["caseA-elapsed-ms"] = Date.now() - startA;

      // Case B: 503 then 200
      requests = 0;
      const startB = Date.now();
      port = await startServer(async () => {
        if (requests <= 3) {
          return new Response(JSON.stringify({ code: "PGRST002" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const urlB = `http://127.0.0.1:${port}/rest/v1/t`;
      const clientB = createClient(urlB, "anon-key");
      await clientB.from("t").select("*").execute();
      measurements["caseB-attempts"] = requests;
      measurements["caseB-elapsed-ms"] = Date.now() - startB;

      // Case C: Closed port
      requests = 0;
      const startC = Date.now();
      // We don't start a server for Case C, just use a dead port
      const urlC = `http://127.0.0.1:1`;
      const clientC = createClient(urlC, "anon-key");
      try {
        await clientC.from("t").select("*").execute();
      } catch (e) {
        // Expect failure
      }
      measurements["caseC-attempts"] = requests; // Note: Bun.serve handles the requests, but if port is closed, no request reaches it.
      // If port is closed, requests will stay 0.
      measurements["caseC-elapsed-ms"] = Date.now() - startC;

      return {
        id: "W02",
        title: "W02 - supabase-js retry behaviour under JWT rejection vs 5xx",
        status: "pass" as const,
        measurements,
      };
    } catch (e: any) {
      return {
        id: "W02",
        title: "W02 - supabase-js retry behaviour under JWT rejection vs 5xx",
        status: "fail" as const,
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};
