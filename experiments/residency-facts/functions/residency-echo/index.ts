// Minimal function for R04. The measurement is the gateway-added
// x-sb-edge-region response header, not the body - the body just proves the
// invocation executed. Deployed with --no-verify-jwt by the test.
Deno.serve(() =>
  new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  })
);
