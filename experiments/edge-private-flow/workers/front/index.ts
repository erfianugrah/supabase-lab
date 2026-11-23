// front: stand-in for the customer's edge in front of Supabase. Adds the
// shared-secret header the function and RLS check, pins the function region,
// and passes the caller's apikey/Authorization through. Paths:
//   /fn/<name>?...  -> <SUPABASE_URL>/functions/v1/<name>   (?pin=0 skips the pin)
//   /rest/v1/...    -> <SUPABASE_URL>/rest/v1/...
interface Env {
  SUPABASE_URL: string;
  FRONT_SECRET: string;
  PIN_REGION: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    const pin = env.PIN_REGION && u.searchParams.get("pin") !== "0";
    let target: URL;
    if (u.pathname.startsWith("/fn/")) {
      target = new URL(`${env.SUPABASE_URL}/functions/v1/${u.pathname.slice(4)}${u.search}`);
      target.searchParams.delete("pin");
      if (pin) target.searchParams.set("forceFunctionRegion", env.PIN_REGION);
    } else if (u.pathname.startsWith("/rest/v1/")) {
      target = new URL(`${env.SUPABASE_URL}${u.pathname}${u.search}`);
    } else {
      return new Response("not found", { status: 404 });
    }
    const h = new Headers();
    for (const k of ["authorization", "apikey", "content-type", "accept", "prefer"]) {
      const v = req.headers.get(k);
      if (v) h.set(k, v);
    }
    h.set("x-gw-secret", env.FRONT_SECRET);
    if (pin) h.set("x-region", env.PIN_REGION);
    const t = performance.now();
    const r = await fetch(target.toString(), {
      method: req.method,
      headers: h,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });
    const out = new Headers(r.headers);
    out.set("x-front-ms", String(Math.round(performance.now() - t)));
    out.set("x-front-colo", String((req as unknown as { cf?: { colo?: string } }).cf?.colo ?? ""));
    return new Response(r.body, { status: r.status, headers: out });
  },
};
