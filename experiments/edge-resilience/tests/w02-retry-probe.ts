/**
 * W02 - supabase-js retry behaviour under JWT rejection vs 5xx.
 *
 * No project access - local mock only. Measures whether the default client
 * retries a 401 PGRST303 (it must not) and whether it rides out a transient
 * 503 (it must).
 */
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { createClient } from "@supabase/supabase-js";
import sbPkg from "@supabase/supabase-js/package.json" with { type: "json" };

const mod: TestModule = {
  id: "W02",
  title: "supabase-js retry behaviour under JWT rejection vs 5xx",
  where: "local",
  requires: [],

  async run(ctx: Ctx): Promise<TestResult> {
    const sbVersion: string = (sbPkg as { version?: string }).version ?? "unknown";

    const measurements: Record<string, number | string> = {
      "supabase-js-version": sbVersion,
    };

    // --- Case A: 401 PGRST303 must NOT be retried ---
    let serverA: ReturnType<typeof Bun.serve> | null = null;
    let requestsA = 0;
    try {
      serverA = Bun.serve({
        port: 0,
        fetch(_req) {
          requestsA++;
          return new Response(JSON.stringify({ code: "PGRST303" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      const urlA = `http://127.0.0.1:${serverA.port}`;
      const startA = Date.now();
      await createClient(urlA, "anon").from("t").select("*");
      measurements["caseA-attempts"] = requestsA;
      measurements["caseA-elapsed-ms"] = Date.now() - startA;
    } finally {
      serverA?.stop();
      serverA = null;
    }

    // --- Case B: 503 x3 then 200 must succeed after >1 attempt ---
    let serverB: ReturnType<typeof Bun.serve> | null = null;
    let requestsB = 0;
    let caseBSuccess = false;
    try {
      serverB = Bun.serve({
        port: 0,
        fetch(_req) {
          requestsB++;
          if (requestsB <= 3) {
            return new Response(JSON.stringify({ code: "PGRST002" }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Range": "0-0/*",
            },
          });
        },
      });
      const urlB = `http://127.0.0.1:${serverB.port}`;
      const startB = Date.now();
      const resultB = await createClient(urlB, "anon").from("t").select("*");
      caseBSuccess = resultB.error === null;
      measurements["caseB-attempts"] = requestsB;
      measurements["caseB-elapsed-ms"] = Date.now() - startB;
      measurements["caseB-success"] = caseBSuccess ? 1 : 0;
    } finally {
      serverB?.stop();
      serverB = null;
    }

    // --- Case C: closed port (document; do not assert) ---
    let serverC: ReturnType<typeof Bun.serve> | null = null;
    try {
      // Start a server, get a port, then stop it so the port is closed.
      serverC = Bun.serve({ port: 0, fetch(_req) { return new Response(""); } });
      const closedPort = serverC.port;
      serverC.stop();
      serverC = null;

      const startC = Date.now();
      const resultC = await createClient(`http://127.0.0.1:${closedPort}`, "anon")
        .from("t")
        .select("*");
      measurements["caseC-error"] = resultC.error?.message?.slice(0, 80) ?? "none";
      measurements["caseC-elapsed-ms"] = Date.now() - startC;
    } catch (e: unknown) {
      measurements["caseC-error"] = e instanceof Error ? e.message.slice(0, 80) : String(e);
    } finally {
      serverC?.stop();
      serverC = null;
    }

    const caseAOk = requestsA === 1;
    const caseBOk = caseBSuccess && requestsB > 1;

    if (!caseAOk || !caseBOk) {
      const failing: string[] = [];
      if (!caseAOk) failing.push(`caseA: expected 1 attempt, got ${requestsA}`);
      if (!caseBOk) failing.push(`caseB: success=${caseBSuccess}, attempts=${requestsB}`);
      return {
        id: "W02",
        title: this.title,
        status: "fail",
        detail: failing.join("; "),
        measurements,
      };
    }

    return {
      id: "W02",
      title: this.title,
      status: "pass",
      detail: `caseA: 1 attempt (no retry on PGRST303); caseB: ${requestsB} attempts then success`,
      measurements,
    };
  },
};

export default mod;
