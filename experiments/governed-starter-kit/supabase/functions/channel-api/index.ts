/**
 * channel-api: a backend-for-frontend for one app screen. The app makes one
 * request; this function fans out to the four upstream endpoints in parallel
 * (fanout.ts), each with its own timeout, and returns one aggregated JSON
 * document with per-upstream status and timing. A failed or slow upstream
 * makes the response `partial: true` instead of failing it.
 *
 *   GET /functions/v1/channel-api            (Authorization: Bearer <user JWT>)
 *     ?refresh=1               skip the cache read (still stores fresh data)
 *     ?fail=offers,points      demo only: ask the mock upstream to fail these
 *     ?slow=points             demo only: ask the mock upstream to answer late
 *
 * Auth. verify_jwt stays on (the platform default), and withSupabase({ auth:
 * 'user' }) from @supabase/server verifies the JWT again, as in the agent
 * function. The user id sent upstream (x-user-id) comes from the verified
 * claims, never from the request. Cache reads run as the user (ctx.supabase,
 * RLS on private.channel_cache); cache writes use ctx.supabaseAdmin through
 * public.channel_cache_put, the one RPC only service_role may execute, so a
 * user cannot write the cache directly (sql/50-channel.sql has the trade-off
 * against an in-memory cache).
 *
 * Configuration (function secrets, never in code):
 *   UPSTREAM_BASE_URL            e.g. https://<ref>.supabase.co/functions/v1/upstream-mock
 *   UPSTREAM_API_KEY             shared key the upstream checks (x-api-key)
 *   CHANNEL_UPSTREAM_TIMEOUT_MS  per-call timeout, default 800, 50-10000
 *
 * The fail/slow knobs exist to drive the mock in a demo. Against a real
 * upstream, remove them: a client should not be able to steer upstream calls.
 */
import { withSupabase } from "npm:@supabase/server@1.9.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.2";
import { type Cache, type CacheEntry, type CacheWrite, type Endpoint, fanOut, parseControls } from "./fanout.ts";

const DEFAULT_TIMEOUT_MS = 800;

function timeoutMs(): number {
  const n = Number(Deno.env.get("CHANNEL_UPSTREAM_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(n) ? Math.max(50, Math.min(Math.trunc(n), 10_000)) : DEFAULT_TIMEOUT_MS;
}

function pgCache(user: SupabaseClient, admin: SupabaseClient, userId: string): Cache {
  return {
    async get(endpoints: Endpoint[]): Promise<CacheEntry[]> {
      const { data, error } = await user.rpc("channel_cache_get", { p_endpoints: endpoints });
      if (error) throw new Error(`cache read: ${error.message}`);
      return (data ?? []) as CacheEntry[];
    },
    async put(entries: CacheWrite[]): Promise<void> {
      const { error } = await admin.rpc("channel_cache_put", { p_user: userId, p_entries: entries });
      if (error) throw new Error(`cache write: ${error.message}`);
    },
  };
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "GET") return Response.json({ error: "GET only" }, { status: 405 });
    const baseUrl = Deno.env.get("UPSTREAM_BASE_URL");
    const apiKey = Deno.env.get("UPSTREAM_API_KEY");
    if (!baseUrl || !apiKey) {
      return Response.json(
        { error: "upstream not configured: set the UPSTREAM_BASE_URL and UPSTREAM_API_KEY function secrets", code: "upstream_not_configured" },
        { status: 503 },
      );
    }
    const userId = ctx.userClaims?.id;
    if (!userId) return Response.json({ error: "no user in the verified token" }, { status: 401 });

    try {
      const agg = await fanOut({
        baseUrl,
        apiKey,
        userId,
        timeoutMs: timeoutMs(),
        controls: parseControls(new URL(req.url).searchParams),
        cache: pgCache(ctx.supabase as unknown as SupabaseClient, ctx.supabaseAdmin as unknown as SupabaseClient, userId),
      });
      if (agg.cache.error) console.error("channel cache", agg.cache.error);
      const timing = [
        `total;dur=${agg.total_ms}`,
        `cache;dur=${agg.cache.read_ms + agg.cache.write_ms}`,
        ...Object.entries(agg.upstreams).map(([e, u]) => `${e};dur=${u.ms};desc="${u.source} ${u.status}"`),
      ].join(", ");
      // 200 while anything useful came back; 502 only when every upstream failed.
      const anyOk = Object.values(agg.upstreams).some((u) => u.status === "ok");
      return Response.json(
        { screen: "home", user_id: userId, ...agg },
        { status: anyOk ? 200 : 502, headers: { "Server-Timing": timing, "Cache-Control": "private, no-store" } },
      );
    } catch (e) {
      console.error(e);
      return Response.json({ error: "internal error", code: "internal" }, { status: 500 });
    }
  }),
};
