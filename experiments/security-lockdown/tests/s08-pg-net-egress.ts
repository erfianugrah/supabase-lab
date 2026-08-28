/**
 * S08 - pg_net: the database can make outbound HTTP.
 *
 * An egress surface most lockdown plans forget: with pg_net enabled, anyone
 * who can run SQL (a SQL-injection, a compromised function, a broad grant) can
 * make the database call out - exfiltration and SSRF from inside Postgres.
 * This measures whether the DB can reach the internet, so it is accounted for
 * rather than assumed absent.
 *
 * DESTRUCTIVE: creates the pg_net extension (left in place; harmless on a
 * throwaway, and the finding is that it CAN be enabled).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

async function rows(ctx: Ctx, q: string): Promise<Record<string, unknown>[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: q });
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mod: TestModule = {
  id: "S08",
  title: "pg_net egress: the database can call out (an attack surface to account for)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    try {
      await rows(ctx, "create extension if not exists pg_net;");
      const req = await rows(ctx, "select net.http_get('https://example.com') as id;");
      const id = Number(req[0]?.id ?? -1);
      if (id < 0) {
        return [{ id: "S08", title: this.title, status: "info", detail: "pg_net not available / http_get returned no request id" }];
      }
      // The response lands asynchronously in net._http_response.
      let status = -1;
      for (let i = 0; i < 20; i++) {
        const resp = await rows(ctx, `select status_code from net._http_response where id = ${id};`);
        if (resp.length) { status = Number(resp[0]?.status_code ?? -1); break; }
        await sleep(2000);
      }
      results.push({
        id: "S08a",
        title: "the database reached an external host over HTTP",
        status: status >= 200 && status < 400 ? "pass" : "info",
        detail: `net.http_get('https://example.com') -> status ${status}. The DB has outbound HTTP; a SQL-capable attacker can exfiltrate or SSRF from inside Postgres. Restrict who holds EXECUTE on the net schema, or leave pg_net disabled if unused.`,
        measurements: { egress_status: status },
      });
    } catch (e) {
      results.push({ id: "S08err", title: "S08 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    }
    return results;
  },
};
export default mod;
