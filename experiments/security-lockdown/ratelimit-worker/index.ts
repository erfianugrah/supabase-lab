/**
 * S12 - the Cloudflare Worker rate-limiter variant of S05.
 *
 * Same job as the nginx demonstrator (security-lockdown ratelimit.nginx.conf),
 * different edge: a Worker using the native Rate Limiting binding in front of
 * the self-hosted PostgREST. The rule that matters is identical - it only works
 * fronting a CLOSED origin (managed Data API off), which is why the managed
 * endpoint cannot be rate-limited this way but your own PostgREST can.
 *
 * Run locally with `wrangler dev` so it fronts the localhost PostgREST
 * container (no deploy, no cost); the deployed form is the same file with a
 * public route.
 */
export interface Env {
  RL: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  ORIGIN: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Per-caller key; locally every request shares one source IP, which is the
    // point - the limiter throttles a single caller's burst.
    const key = req.headers.get("cf-connecting-ip") ?? "local";
    const { success } = await env.RL.limit({ key });
    if (!success) return new Response("rate limited\n", { status: 429 });
    if (!env.ORIGIN) return new Response("ORIGIN unset\n", { status: 503 });
    const url = new URL(req.url);
    const target = new URL(url.pathname + url.search, env.ORIGIN);
    return fetch(new Request(target, req));
  },
};
