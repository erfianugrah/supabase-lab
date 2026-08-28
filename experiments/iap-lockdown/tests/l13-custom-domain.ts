/**
 * L13 - the CNAME + CORS misconceptions, measured.
 *
 * The custom-domain CNAME is often read as an access-control lever, and CORS
 * is often hoped to restrict the API. Both are measured here as the
 * misconceptions they are:
 *
 *   L13-cors-a - PostgREST honours an Origin (returns an
 *                Access-Control-Allow-Origin header), but that is a
 *                browser-only signal.
 *   L13-cors-b - Auth (GoTrue) does not return CORS headers the same way -
 *                the PostgREST-yes / Auth-no asymmetry, recorded.
 *   L13-cors-c - the point: a non-browser client with NO Origin header still
 *                gets the data (200). CORS gates nothing server-side; curl
 *                ignores it entirely.
 *
 * The custom-domain activation itself (L13a/b) needs DNS records on a
 * lab-controlled zone + the vanity API; recorded as a follow-up when
 * PVLAB_ENDPOINT_CUSTOM_DOMAIN_HOST is set, since the CNAME-gates-nothing
 * result is already implied by L11b (the origin hostname always serves).
 *
 * Read-only in effect, but marked destructive so it sorts AFTER L01 seeds the
 * shared fixture (the CORS "no Origin still serves data" row needs a table).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, TABLE } from "../lib/inventory.js";

async function corsProbe(url: string, key: string, origin?: string): Promise<{ status: number; acao: string }> {
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}` };
  if (origin) headers.Origin = origin;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  await r.text();
  return { status: r.status, acao: r.headers.get("access-control-allow-origin") ?? "<none>" };
}

const mod: TestModule = {
  id: "L13",
  title: "custom domain + CORS: neither gates the API server-side",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true, // ordering only: run after L01 seeds the fixture
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const base = `https://${ctx.apiHost}`;
    const evil = "https://attacker.example";
    const results: TestResult[] = [];

    const restWithOrigin = await corsProbe(`${base}/rest/v1/${TABLE}?select=id&limit=1`, keys.anonJwt, evil);
    const restNoOrigin = await corsProbe(`${base}/rest/v1/${TABLE}?select=id&limit=1`, keys.anonJwt);
    const authWithOrigin = await corsProbe(`${base}/auth/v1/health`, keys.anonJwt, evil);

    results.push({
      id: "L13-cors-a",
      title: "PostgREST reflects an Origin (browser-only signal)",
      status: "info",
      detail: `REST with Origin ${evil}: status ${restWithOrigin.status}, Access-Control-Allow-Origin=${restWithOrigin.acao}`,
      measurements: { rest_acao: restWithOrigin.acao },
    });
    results.push({
      id: "L13-cors-b",
      title: "Auth CORS asymmetry vs PostgREST",
      status: "info",
      detail: `Auth /health with Origin: status ${authWithOrigin.status}, Access-Control-Allow-Origin=${authWithOrigin.acao} (vs REST=${restWithOrigin.acao})`,
      measurements: { auth_acao: authWithOrigin.acao },
    });
    results.push({
      id: "L13-cors-c",
      title: "CORS gates nothing server-side: no Origin, still 200 + data",
      status: restNoOrigin.status === 200 ? "pass" : "fail",
      detail: `a non-browser client sending NO Origin still reads the table (${restNoOrigin.status}). CORS is advisory to browsers; curl ignores it - so 'restrict by CORS' does not restrict the API.`,
      measurements: { no_origin_status: restNoOrigin.status },
    });

    const customHost = ctx.endpoints["custom_domain_host"];
    results.push({
      id: "L13-cname",
      title: "custom-domain CNAME gates nothing (origin always serves)",
      status: "info",
      detail: customHost
        ? `custom host ${customHost} set; activation is a follow-up. The origin ${ctx.apiHost} keeps serving regardless (see L11b) - the CNAME is branding, not access control.`
        : `no custom domain activated this run; L11b already shows the origin hostname always serves, which is what makes the CNAME non-gating.`,
    });

    return results;
  },
};
export default mod;
