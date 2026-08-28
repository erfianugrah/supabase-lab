/**
 * L12 - supabase-js through the Access-gated proxy, browserless.
 *
 * Point createClient() at the L11 Worker (behind the Cloudflare Access
 * self-hosted app) and drive it with an Access SERVICE TOKEN so no browser
 * login is needed - the token rides as Cf-Access-Client-Id / -Secret headers,
 * which Access honours for M2M. Then record which subsystems survive
 * path-prefix proxying through this proxy:
 *
 *   - REST: the Worker forwards /rest with the injected service key -> rows.
 *   - GraphQL: same forward path.
 *   - Storage / Auth: NOT on this Worker's surface (it forwards /rest and
 *     /graphql only, 404s the rest by design) - recorded as the compatibility
 *     result, not a failure of the approach.
 *   - Realtime: the WebSocket upgrade is the casualty even behind a
 *     transparent forward (see security-lockdown/l12/worker.ts); not carried
 *     by a /rest-only proxy at all.
 *
 * Needs the Phase B Cloudflare stack: PVLAB_ENDPOINT_WORKER plus the Access
 * service token in CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET. Self-skips
 * without them.
 *
 * DESTRUCTIVE: none of its own; sorts after L11 in a single run.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { createClient } from "@supabase/supabase-js";
import { fetchKeys, TABLE } from "../lib/inventory.js";

const mod: TestModule = {
  id: "L12",
  title: "supabase-js through the Access-gated proxy: per-subsystem compatibility",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const worker = ctx.endpoints["worker"];
    const cid = process.env.CF_ACCESS_CLIENT_ID ?? "";
    const csec = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
    if (!worker || !cid || !csec) {
      return [{ id: "L12", title: this.title, status: "skip", detail: "needs PVLAB_ENDPOINT_WORKER + CF_ACCESS_CLIENT_ID/SECRET (Phase B Cloudflare stack + Access service token)" }];
    }
    const { anonJwt } = await fetchKeys(ctx);

    // supabase-js transport with the Access service-token headers injected, so
    // every call passes the edge without a browser login.
    const svcFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("CF-Access-Client-Id", cid);
      headers.set("CF-Access-Client-Secret", csec);
      return fetch(input, { ...init, headers });
    }) as unknown as typeof fetch;
    const sb = createClient(worker, anonJwt, { global: { fetch: svcFetch }, auth: { persistSession: false } });
    const results: TestResult[] = [];

    // REST through the proxy.
    try {
      const { data, error } = await sb.from(TABLE).select("id").limit(1);
      results.push({
        id: "L12a",
        title: "REST survives path-prefix proxying through the Access-gated Worker",
        status: !error ? "pass" : "fail",
        detail: error ? `REST via ${worker} -> ERR ${error.message}` : `REST via ${worker} -> ok, rows=${data?.length ?? 0}. The Worker injects the service key server-side and the Access service token cleared the edge - no browser.`,
        measurements: { rest_rows: data?.length ?? 0, rest_error: error ? error.message.slice(0, 60) : "" },
      });
    } catch (e) {
      results.push({ id: "L12a", title: "REST via proxy", status: "fail", detail: `EX ${e instanceof Error ? e.message : String(e)}` });
    }

    // Storage: not on this Worker's forwarded surface (by design).
    try {
      const { error } = await sb.storage.listBuckets();
      results.push({
        id: "L12b",
        title: "Storage is not carried by a /rest-only proxy (compatibility fact)",
        status: "info",
        detail: `storage.listBuckets via ${worker} -> ${error ? `blocked (${error.message.slice(0, 50)})` : "unexpectedly served"}. This Worker forwards /rest and /graphql only; carrying Storage/Auth needs a transparent forward.`,
      });
    } catch (e) {
      results.push({ id: "L12b", title: "Storage via proxy", status: "info", detail: `not carried: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}` });
    }

    // Realtime WS is the casualty even behind a transparent forward - recorded,
    // not attempted (a hung WS handshake would just time the run out).
    results.push({
      id: "L12c",
      title: "Realtime WebSocket upgrade is the casualty",
      status: "info",
      detail: "the WS upgrade does not survive a Worker path-prefix proxy (see security-lockdown/l12/worker.ts, transparent-forward variant). A REST/GraphQL proxy does not carry it at all.",
    });
    return results;
  },
};
export default mod;
