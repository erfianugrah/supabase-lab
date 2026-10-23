// Edge Function for ER03: every auth option of lib/named.ts AUTH_TABLE (the
// five ER01 modes plus the named-key forms), selected by ?mode=. The test
// substitutes the server-version placeholder with the version pinned in this
// experiment's package.json and the table placeholder below with AUTH_TABLE as
// JSON, so this function and the Bun server run the same table. Deployed with verify_jwt=false.
// ?mode=_env reports which key names the platform injected (names only).
import { withSupabase } from "npm:@supabase/server@__SERVER_VERSION__";

const AUTH_TABLE: Record<string, string | string[]> = __AUTH_TABLE__;

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

const handlers: Record<string, (req: Request) => Promise<Response>> = {};
for (const [id, auth] of Object.entries(AUTH_TABLE)) handlers[id] = withSupabase({ auth: auth as any }, run);

const bootedAt = new Date().toISOString();

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "";
  if (mode === "_env") {
    const names = (v: string | undefined) => {
      try {
        return Object.keys(JSON.parse(v ?? "{}"));
      } catch {
        return ["<unparseable>"];
      }
    };
    return Response.json({
      publishable_keys_names: names(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")),
      secret_keys_names: names(Deno.env.get("SUPABASE_SECRET_KEYS")),
      booted_at: bootedAt,
    });
  }
  const h = handlers[mode];
  if (!h) return new Response(JSON.stringify({ error: "unknown mode" }), { status: 404 });
  return h(req);
});
