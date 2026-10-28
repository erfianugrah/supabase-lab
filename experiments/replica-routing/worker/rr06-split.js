/**
 * RR06g: one hostname in front of a project that has a custom domain and a read
 * replica. GET and HEAD on /rest/v1/* go to the API load balancer (READ_ORIGIN,
 * `<ref>-all.supabase.co`); everything else - Auth, writes, Storage, Functions -
 * goes to the custom domain (WRITE_ORIGIN), so OAuth callbacks keep the custom
 * host. `x-rr06-route` on the response says which way a request went.
 *
 * No CORS handling: the origin's own CORS headers pass through unchanged, and
 * RR06 runs from a script, not a browser.
 */
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const read = (req.method === "GET" || req.method === "HEAD") && u.pathname.startsWith("/rest/v1/");
    const target = new URL(u.pathname + u.search, read ? env.READ_ORIGIN : env.WRITE_ORIGIN);
    const res = await fetch(new Request(target, req));
    const h = new Headers(res.headers);
    h.set("x-rr06-route", read ? "read" : "write");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
