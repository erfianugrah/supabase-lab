// Canary: reports the build hash baked in at deploy time, an isolate id, and
// can answer with an injected status (?fail=503) so a client's retry behaviour
// is observable from both ends. The BUILD literal below is substituted by the
// test on every deploy.
//
// Injected failures also record one row per received request in public.er_hits
// (via PostgREST with the injected secret key), because an in-memory counter is
// not a reliable witness: a function may be booted fresh for each request, so
// a retry would land on an isolate whose counter starts at 1 again.
const BUILD = "__BUILD__";
const ISOLATE = crypto.randomUUID();
const BOOTED_AT = Date.now();
let served = 0;

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    return keys.default ?? Object.values(keys)[0] ?? "";
  } catch {
    return "";
  }
}

Deno.serve(async (req: Request) => {
  served++;
  const url = new URL(req.url);
  const fail = url.searchParams.get("fail");
  if (fail) {
    const probe = req.headers.get("x-probe-id") ?? "none";
    let hitStatus = 0;
    try {
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/er_hits`, {
        method: "POST",
        headers: { apikey: secretKey(), "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ probe, isolate: ISOLATE }),
      });
      hitStatus = r.status;
      await r.text();
    } catch {
      hitStatus = -1;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-er-hit-status": String(hitStatus),
      "x-er-isolate": ISOLATE,
    };
    const retryAfter = url.searchParams.get("retry_after");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    return new Response(JSON.stringify({ injected: Number(fail), build: BUILD }), {
      status: Number(fail),
      headers,
    });
  }
  return Response.json(
    {
      build: BUILD,
      isolate: ISOLATE,
      age_ms: Date.now() - BOOTED_AT,
      served,
      region: Deno.env.get("SB_REGION") ?? null,
      execution_id: Deno.env.get("SB_EXECUTION_ID") ?? null,
    },
    { headers: { "x-er-build": BUILD } },
  );
});
