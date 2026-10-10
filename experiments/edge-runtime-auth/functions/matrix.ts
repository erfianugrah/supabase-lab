// Edge Function: one @supabase/server handler per auth mode, selected by ?mode=.
// Deployed with verify_jwt=false (the documented requirement for any mode but
// 'user') and, separately, with verify_jwt=true to expose the gateway layer.
// A response that carries x-er-handler: ran means the handler body executed;
// a rejection from the library carries x-supabase-server-error instead.
// __SERVER_VERSION__ is replaced by the test with the version installed in this
// experiment's package.json, so the function and the Worker bundle agree.
import { withSupabase } from "npm:@supabase/server@__SERVER_VERSION__";

const run = async (_req: Request, ctx: any) =>
  new Response(
    JSON.stringify({
      ran: true,
      authMode: ctx.authMode ?? null,
      keyName: ctx.authKeyName ?? null,
      hasUserClaims: ctx.userClaims != null,
    }),
    { headers: { "Content-Type": "application/json", "x-er-handler": "ran" } },
  );

const handlers: Record<string, (req: Request) => Promise<Response>> = {
  none: withSupabase({ auth: "none" }, run),
  user: withSupabase({ auth: "user" }, run),
  secret: withSupabase({ auth: "secret" }, run),
  publishable: withSupabase({ auth: "publishable" }, run),
  user_secret: withSupabase({ auth: ["user", "secret"] }, run),
};

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "";
  if (mode === "_env") {
    // Which of the documented variables the runtime injects. Names and counts
    // only, never values.
    const names = (v: string | undefined) => {
      try {
        return Object.keys(JSON.parse(v ?? "{}"));
      } catch {
        return ["<unparseable>"];
      }
    };
    const jwks = Deno.env.get("SUPABASE_JWKS");
    let kids: string[] = [];
    try {
      const parsed = JSON.parse(jwks ?? "null");
      const keys = Array.isArray(parsed) ? parsed : parsed?.keys ?? [];
      kids = keys.map((k: any) => `${k.kty ?? "?"}/${k.alg ?? "?"}`);
    } catch {
      kids = ["<unparseable>"];
    }
    return Response.json({
      publishable_keys_names: names(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")),
      secret_keys_names: names(Deno.env.get("SUPABASE_SECRET_KEYS")),
      singular_publishable_set: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") != null,
      singular_secret_set: Deno.env.get("SUPABASE_SECRET_KEY") != null,
      jwks_set: jwks != null,
      jwks_key_types: kids,
      jwks_url_set: Deno.env.get("SUPABASE_JWKS_URL") != null,
      sb_execution_id_set: Deno.env.get("SB_EXECUTION_ID") != null,
      function_slug_set: Deno.env.get("SUPABASE_FUNCTION_SLUG") != null,
    });
  }
  const h = handlers[mode];
  if (!h) return new Response(JSON.stringify({ error: "unknown mode" }), { status: 404 });
  return h(req);
});
