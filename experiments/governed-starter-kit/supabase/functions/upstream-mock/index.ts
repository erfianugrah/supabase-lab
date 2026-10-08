/**
 * upstream-mock: stands in for the upstream integration layer the channel API
 * fans out to. Four read endpoints, each returning a small JSON document for
 * the user named in x-user-id, after a configurable delay:
 *
 *   GET /upstream-mock/profile   Cache-Control: private, max-age=300
 *   GET /upstream-mock/orders    Cache-Control: no-store
 *   GET /upstream-mock/offers    Cache-Control: private, max-age=60
 *   GET /upstream-mock/points    Cache-Control: no-store
 *
 * Query parameters (all optional):
 *   latency_ms=<n>    delay before answering (default per endpoint, below)
 *   mode=ok           normal answer (default)
 *   mode=fail         503 after the delay, like an upstream outage
 *   mode=slow         answers after slow_ms instead (default 3000), long past
 *                     the channel API's per-call timeout
 *
 * Auth is a shared key in x-api-key, compared in constant time, the way an
 * API gateway in front of a real integration layer would check a client: the
 * caller is the channel API, not a user, so it is deployed with
 * --no-verify-jwt. It fails closed - no UPSTREAM_API_KEY secret, no answers.
 * Data is generated from the user id, so nothing here reads the database.
 */

// The cacheable endpoints are the slow ones by default, so a cache hit shows
// up in the screen's latency (bounded by orders then) and not only in the
// upstream call count.
const DEFAULT_LATENCY_MS: Record<string, number> = { profile: 250, orders: 120, offers: 180, points: 60 };
const CACHE_CONTROL: Record<string, string> = {
  profile: "private, max-age=300",
  orders: "no-store",
  offers: "private, max-age=60",
  points: "no-store",
};
const MAX_DELAY_MS = 10_000;
const DEFAULT_SLOW_MS = 3_000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Small deterministic number from the user id, so repeated calls agree. */
function seed(userId: string, salt: string): number {
  let h = 2166136261;
  for (const ch of userId + salt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function payload(endpoint: string, userId: string): unknown {
  const s = (salt: string) => seed(userId, salt);
  const generatedAt = new Date().toISOString();
  switch (endpoint) {
    case "profile":
      return { user_id: userId, display_name: `Member ${s("n") % 10000}`, tier: ["standard", "silver", "gold"][s("t") % 3], locale: "en", generated_at: generatedAt };
    case "orders":
      return {
        items: [1, 2].map((i) => ({ id: `ord-${s(`o${i}`) % 100000}`, status: ["confirmed", "pending", "completed"][s(`s${i}`) % 3], total: (s(`a${i}`) % 50000) / 100 })),
        generated_at: generatedAt,
      };
    case "offers":
      return {
        items: [1, 2, 3].map((i) => ({ id: `off-${s(`f${i}`) % 1000}`, title: `Offer ${i}`, discount_pct: 5 + (s(`d${i}`) % 20) })),
        generated_at: generatedAt,
      };
    case "points":
      return { balance: s("p") % 100000, expiring_next_30d: s("e") % 500, generated_at: generatedAt };
    default:
      return null;
  }
}

function intParam(v: string | null, fallback: number): number {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), MAX_DELAY_MS)) : fallback;
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json(405, { error: "GET only" });

  const expected = Deno.env.get("UPSTREAM_API_KEY");
  if (!expected) return json(503, { error: "upstream not configured (UPSTREAM_API_KEY unset)" });
  if (!(await sameSecret(req.headers.get("x-api-key") ?? "", expected))) return json(401, { error: "bad or missing x-api-key" });

  const url = new URL(req.url);
  const endpoint = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!(endpoint in CACHE_CONTROL)) return json(404, { error: `unknown endpoint ${endpoint}` });
  const userId = req.headers.get("x-user-id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return json(400, { error: "x-user-id must be a uuid" });

  const mode = url.searchParams.get("mode") ?? "ok";
  if (!["ok", "fail", "slow"].includes(mode)) return json(400, { error: "mode must be ok, fail or slow" });
  const delay = mode === "slow"
    ? intParam(url.searchParams.get("slow_ms"), DEFAULT_SLOW_MS)
    : intParam(url.searchParams.get("latency_ms"), DEFAULT_LATENCY_MS[endpoint]);

  // A caller that gives up (the channel API's timeout) aborts req.signal;
  // stop waiting then instead of holding the isolate for the full delay.
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, delay);
    req.signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

  const timing = { "Server-Timing": `upstream;dur=${delay}` };
  if (mode === "fail") return json(503, { error: `${endpoint} upstream unavailable (forced)` }, timing);
  return json(200, payload(endpoint, userId), { ...timing, "Cache-Control": CACHE_CONTROL[endpoint] });
});
