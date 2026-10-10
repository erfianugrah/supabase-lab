// Worker: the same five @supabase/server modes as functions/matrix.ts, for a
// Workers-style runtime. Two env paths are exposed so the run can separate them:
//   ?env=auto      relies on the library reading process.env (nodejs_compat)
//   ?env=override  passes url/keys explicitly from the Worker env bindings
//   ?env=jwks      override plus the project's JWKS inline (no JWKS fetch at runtime)
import { withSupabase } from "@supabase/server";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
  /** The project's JWKS document, used only by ?env=jwks. */
  ER_JWKS?: string;
  ER_APIKEY?: string;
}

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

const AUTH: Record<string, any> = {
  none: "none",
  user: "user",
  secret: "secret",
  publishable: "publishable",
  user_secret: ["user", "secret"],
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") ?? "";
    const envPath = url.searchParams.get("env") ?? "auto";
    if (mode === "_runtime") {
      return Response.json({
        process_env_has_url: typeof process !== "undefined" && process.env?.SUPABASE_URL != null,
        binding_has_url: env.SUPABASE_URL != null,
        has_deno: typeof (globalThis as any).Deno !== "undefined",
        user_agent: (globalThis.navigator as any)?.userAgent ?? null,
        cf_colo: (req as any).cf?.colo ?? null,
      });
    }
    if (mode === "_jwks") {
      // Can this runtime reach the project's published JWKS, with and without an apikey?
      const target = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
      const one = async (headers: Record<string, string>) => {
        try {
          const r = await fetch(target, { headers });
          const t = await r.text();
          return { status: r.status, bytes: t.length, head: t.slice(0, 60) };
        } catch (e) {
          return { status: 0, bytes: 0, head: `ERR:${String(e).slice(0, 80)}` };
        }
      };
      return Response.json({ no_apikey: await one({}), with_apikey: await one({ apikey: env.ER_APIKEY ?? env.SUPABASE_PUBLISHABLE_KEY }) });
    }
    const auth = AUTH[mode];
    if (auth === undefined) return new Response(JSON.stringify({ error: "unknown mode" }), { status: 404 });
    const cfg: any = { auth };
    if (envPath === "override" || envPath === "jwks") {
      cfg.env = {
        url: env.SUPABASE_URL,
        publishableKeys: { default: env.SUPABASE_PUBLISHABLE_KEY },
        secretKeys: { default: env.SUPABASE_SECRET_KEY },
        ...(envPath === "jwks" && env.ER_JWKS ? { jwks: JSON.parse(env.ER_JWKS) } : {}),
      };
    }
    return withSupabase(cfg, run)(req);
  },
};
