/**
 * L11 IAP-as-proxy Worker.
 *
 * Deployed behind the Cloudflare Access self-hosted app (cloudflare.tf
 * iap_proxy) at <subdomain>.<zone>. Access enforces identity at the edge, so
 * every request that reaches this Worker already carries a verified
 * Cf-Access-Jwt-Assertion. The Worker holds the Supabase SERVICE key (a
 * secret, never shipped to the browser) and proxies the REST surface.
 *
 * The measurement L11 cares about is the BYPASS: this proxy gates nothing on
 * its own, because <ref>.supabase.co keeps answering anyone who holds a key.
 * The proxy only becomes a real gate once the keys are revoked (L05) and RLS
 * is keyed on identity (L10). This Worker is the "before" side of that.
 *
 * Config (set at deploy time, NOT committed):
 *   var    UPSTREAM     - https://<ref>.supabase.co
 *   secret SERVICE_KEY  - the project service_role key
 */
export interface Env {
  UPSTREAM: string;
  SERVICE_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Health/ident endpoint - echoes the Access identity the edge injected.
    if (url.pathname === "/whoami") {
      const assertion = req.headers.get("Cf-Access-Jwt-Assertion") ?? "";
      const email = req.headers.get("Cf-Access-Authenticated-User-Email") ?? "";
      return Response.json({
        proxied: true,
        access_present: Boolean(assertion),
        access_email: email,
      });
    }

    // Proxy the REST surface with the injected service key. supabase-js can be
    // pointed here (L12). Only /rest and /graphql are forwarded; everything
    // else 404s so the proxy has an explicit surface.
    if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/graphql/")) {
      if (!env.UPSTREAM || !env.SERVICE_KEY) {
        return new Response("proxy not configured (UPSTREAM/SERVICE_KEY unset)", { status: 503 });
      }
      const origin = new URL(url.pathname + url.search, env.UPSTREAM);
      const headers = new Headers(req.headers);
      headers.set("apikey", env.SERVICE_KEY);
      headers.set("Authorization", `Bearer ${env.SERVICE_KEY}`);
      headers.delete("cf-access-jwt-assertion");
      const resp = await fetch(
        new Request(origin, { method: req.method, headers, body: req.body, redirect: "manual" }),
      );
      const out = new Response(resp.body, resp);
      out.headers.set("x-iap-proxy", "1");
      return out;
    }

    return new Response("not found", { status: 404 });
  },
};
