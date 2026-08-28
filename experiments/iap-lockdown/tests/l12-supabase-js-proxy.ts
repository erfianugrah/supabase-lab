/**
 * L12 - supabase-js through the proxy.
 *
 * Point createClient() at the worker URL (L11) with the per-subsystem
 * overrides (restUrl, storageUrl, realtimeUrl, functionsUrl) and record
 * which subsystems survive path-prefix proxying:
 *
 *   - PostgREST: expected to work through a path-preserving proxy.
 *   - Auth: token endpoint through the proxy.
 *   - Storage: object + render paths.
 *   - Realtime: WebSocket upgrade through a Worker is the expected casualty
 *     (WS over CF Workers needs explicit upgrade handling; record verbatim).
 *   - Edge Functions: invocation path through the proxy.
 *
 * Output is a compatibility table: subsystem x (direct | proxied) x result.
 *
 * DESTRUCTIVE: none beyond the L11 deploy it depends on; marked destructive
 * only to sort after L11 in a single run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L12",
  title: "supabase-js through the proxy: per-subsystem compatibility table",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L12",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Depends on L11's worker URL (PVLAB_ENDPOINT_WORKER).",
    };
  },
};
export default mod;
