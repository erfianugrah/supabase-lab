/**
 * L07 - Edge Function verify_jwt.
 *
 *   L07a - EF_OPEN (verify_jwt=false, seeded by L01): anonymous 200 -
 *          an EF is public-by-default, no key needed.
 *   L07b - deploy EF_LOCKED (verify_jwt=true): anonymous probe -> refusal
 *          verbatim (poll until stable; deploy propagation lags, W25 ~10.6s).
 *   L07c - EF_LOCKED + anon key: does the anon JWT satisfy the gate?
 *          If yes, verify_jwt is a key-possession check, NOT an authorization
 *          control - the distinction that matters for the IAP story.
 *
 * DESTRUCTIVE: deploys EF_LOCKED; deletes it in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, http, EF_OPEN, EF_LOCKED } from "../lib/inventory.js";

const BODY =
  "Deno.serve(() => new Response(JSON.stringify({ ok: true, fn: 'locked' }), { headers: { 'Content-Type': 'application/json' } }))";

const mod: TestModule = {
  id: "L07",
  title: "Edge Function verify_jwt: public-by-default, and what the gate actually checks",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const base = `https://${ctx.apiHost}`;
    const results: TestResult[] = [];

    // L07a - the open function is anonymously callable.
    const open = await http(`${base}/functions/v1/${EF_OPEN}`, {});
    results.push({
      id: "L07a",
      title: "verify_jwt=false EF is anonymously callable",
      status: open.status === 200 ? "pass" : "info",
      detail: `anon (no key) -> ${open.status} ${open.code}`,
      measurements: { open_anon_status: open.status },
    });

    try {
      const dep = await mgmt(ctx, "POST", `/projects/${ctx.ref}/functions`, {
        slug: EF_LOCKED,
        name: EF_LOCKED,
        verify_jwt: true,
        body: BODY,
      });
      results.push({
        id: "L07b0",
        title: "deploy EF_LOCKED (verify_jwt=true)",
        status: dep.status < 300 ? "pass" : "fail",
        measurements: { deploy_status: dep.status },
        evidence: dep.status < 300 ? undefined : dep.text.slice(0, 300),
      });
      if (dep.status >= 300) return results;

      // L07b - anonymous (no key) probe: poll until the refusal is stable
      // (a fresh deploy may 404 before it is live).
      let anonProbe = await http(`${base}/functions/v1/${EF_LOCKED}`, {});
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000 && anonProbe.status !== 401) {
        await new Promise((r) => setTimeout(r, 5000));
        anonProbe = await http(`${base}/functions/v1/${EF_LOCKED}`, {});
      }
      results.push({
        id: "L07b",
        title: "verify_jwt=true refuses the anonymous caller",
        status: anonProbe.status === 401 ? "pass" : "fail",
        detail: `anon (no key) -> ${anonProbe.status} ${anonProbe.code} after ${Math.round((Date.now() - t0) / 1000)}s`,
        measurements: { locked_anon_status: anonProbe.status, locked_anon_code: anonProbe.code },
      });

      // L07c - the anon PROJECT key against the gate.
      const withAnon = await http(`${base}/functions/v1/${EF_LOCKED}`, { key: keys.anonJwt });
      results.push({
        id: "L07c",
        title: "does the anon project key satisfy verify_jwt?",
        status: "info",
        detail:
          withAnon.status === 200
            ? "anon key -> 200: verify_jwt checks KEY POSSESSION, not identity - any valid project JWT passes, so it is not an authorization control"
            : `anon key -> ${withAnon.status} ${withAnon.code}: the gate rejects the anon key too (stricter than key-possession)`,
        measurements: { locked_anonkey_status: withAnon.status, locked_anonkey_code: withAnon.code },
      });
    } finally {
      const del = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${EF_LOCKED}`);
      results.push({
        id: "L07z",
        title: "delete EF_LOCKED",
        status: del.status < 300 || del.status === 404 ? "pass" : "fail",
        detail: del.status < 300 || del.status === 404 ? "deleted" : `delete HTTP ${del.status} - EF_LOCKED LEFT DEPLOYED`,
        measurements: { delete_status: del.status },
      });
    }
    return results;
  },
};
export default mod;
