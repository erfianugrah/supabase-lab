// Bun server: the @supabase/server handlers of functions/matrix.ts plus the
// named-key forms, on Bun's own HTTP server (Bun.serve), bound to loopback.
// ER03 starts one process per env configuration with a clean environment:
//   ER_ENV_PATH=auto      the library reads process.env (SUPABASE_* set by ER03)
//   ER_ENV_PATH=override  no SUPABASE_* variables; url, both key sets and the
//                         JWKS are passed as the `env` option from ER_* variables
// A response that carries x-er-handler: ran means the handler body executed.
import { withSupabase } from "@supabase/server";
import pkg from "@supabase/server/package.json";
import { AUTH_TABLE } from "../lib/named";

const envPath = process.env.ER_ENV_PATH ?? "auto";
const port = Number(process.env.ER_PORT ?? "0");

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

const override =
  envPath === "override"
    ? {
        url: process.env.ER_URL ?? "",
        publishableKeys: JSON.parse(process.env.ER_PUBLISHABLE_KEYS ?? "{}"),
        secretKeys: JSON.parse(process.env.ER_SECRET_KEYS ?? "{}"),
        ...(process.env.ER_JWKS ? { jwks: JSON.parse(process.env.ER_JWKS) } : {}),
      }
    : undefined;

const handlers: Record<string, (req: Request) => Promise<Response>> = {};
for (const [id, auth] of Object.entries(AUTH_TABLE)) {
  handlers[id] = withSupabase({ auth: auth as any, ...(override ? { env: override } : {}) }, run);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") ?? "";
    if (mode === "_runtime") {
      // Names only, never values.
      const names = (v: string | undefined) => {
        try {
          return Object.keys(JSON.parse(v ?? "{}"));
        } catch {
          return ["<unparseable>"];
        }
      };
      return Response.json({
        bun: Bun.version,
        server_version: (pkg as { version: string }).version,
        env_path: envPath,
        has_deno: typeof (globalThis as any).Deno !== "undefined",
        supabase_vars: Object.keys(process.env).filter((k) => k.startsWith("SUPABASE_")).sort(),
        publishable_keys_names: names(process.env.SUPABASE_PUBLISHABLE_KEYS),
        secret_keys_names: names(process.env.SUPABASE_SECRET_KEYS),
        override_publishable_names: override ? Object.keys(override.publishableKeys) : null,
        override_secret_names: override ? Object.keys(override.secretKeys) : null,
        override_jwks: override ? "jwks" in override : null,
      });
    }
    const h = handlers[mode];
    if (!h) return new Response(JSON.stringify({ error: "unknown mode" }), { status: 404 });
    return h(req);
  },
});

// The parent reads the bound port from this line.
console.log(`ER_LISTENING ${server.port}`);
