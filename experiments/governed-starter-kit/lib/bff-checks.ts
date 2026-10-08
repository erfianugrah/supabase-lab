/**
 * The BFF demo's end-to-end checks, shared by K05 (tests/k05-fanout-api.ts,
 * a deployed project) and scripts/bff-local.ts (a local Docker stack), so the
 * local run exercises exactly the assertions the hosted run will.
 *
 * Needs two signed-in users (`a`, `b`), the publishable key, and the
 * functions + REST base URLs. Timings come from the responses themselves
 * (`total_ms`, per-upstream `ms`, `timeout_ms`), plus the wall time seen here.
 */

export interface Session {
  id: string;
  jwt: string;
}

export interface BffTarget {
  /** e.g. https://<ref>.supabase.co/functions/v1 */
  functionsUrl: string;
  /** e.g. https://<ref>.supabase.co/rest/v1 */
  restUrl: string;
  publishableKey: string;
  a: Session;
  b: Session;
  /** Repetitions per timed scenario. */
  reps: number;
}

export interface BffCheck {
  n: number;
  title: string;
  pass: boolean;
  detail: string;
  measurements?: Record<string, number | string>;
}

interface Upstream {
  status: string;
  source: string;
  ms: number;
  http?: number;
  ttl_s?: number;
  age_s?: number;
  error?: string;
}

type Endpoint = "profile" | "feed" | "inbox" | "stats";

export interface Agg {
  screen: string;
  user_id: string;
  partial: boolean;
  total_ms: number;
  timeout_ms: number;
  cache: { read: string; read_ms: number; write: string; write_ms: number; error?: string };
  data: Record<Endpoint, Record<string, unknown> | null>;
  upstreams: Record<Endpoint, Upstream>;
  error?: string;
  code?: string;
}

export interface Call {
  status: number;
  wall_ms: number;
  body: Agg;
}

export async function callFanout(t: Pick<BffTarget, "functionsUrl" | "publishableKey">, jwt: string | null, query = ""): Promise<Call> {
  const headers: Record<string, string> = { apikey: t.publishableKey };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const t0 = performance.now();
  const r = await fetch(`${t.functionsUrl}/fanout-api${query ? `?${query}` : ""}`, { headers });
  const text = await r.text();
  const wall = Math.round(performance.now() - t0);
  let body: Agg;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 200) } as Agg;
  }
  return { status: r.status, wall_ms: wall, body };
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
};

const src = (c: Call) =>
  Object.entries(c.body.upstreams ?? {})
    .map(([e, u]) => `${e}=${u.source}/${u.status}/${u.ms}ms`)
    .join(" ");
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
const ok = (c: Call, endpoints: Endpoint[]) => endpoints.every((e) => c.body.upstreams?.[e]?.status === "ok");
const profileOf = (c: Call) => (c.body.data?.profile as { user_id?: string } | null)?.user_id;

function timing(calls: Call[]): Record<string, number> {
  const wall = calls.map((c) => c.wall_ms);
  return {
    wall_ms_median: median(wall),
    wall_ms_min: Math.min(...wall),
    wall_ms_max: Math.max(...wall),
    server_total_ms_median: median(calls.map((c) => c.body.total_ms)),
  };
}

export async function bffChecks(t: BffTarget): Promise<BffCheck[]> {
  const out: BffCheck[] = [];
  const add = (n: number, title: string, pass: boolean, detail: string, measurements?: Record<string, number | string>) =>
    out.push({ n, title, pass, detail, ...(measurements ? { measurements } : {}) });
  const reps = async (jwt: string, query: string) => {
    const calls: Call[] = [];
    for (let i = 0; i < t.reps; i++) calls.push(await callFanout(t, jwt, query));
    return calls;
  };

  // 1. No user token, or a tampered one: refused before the function runs.
  const anon = await callFanout(t, null);
  const forged = await callFanout(t, `${t.a.jwt.slice(0, -4)}AAAA`);
  add(1, "no JWT or a tampered JWT is refused", anon.status === 401 && forged.status === 401, `no token http ${anon.status}; tampered signature http ${forged.status}`);

  // 2. All upstreams ok with the cache read skipped (refresh=1): four live calls.
  const cold = await reps(t.a.jwt, "refresh=1");
  add(
    2,
    `all upstreams ok, cache read skipped (refresh=1), x${t.reps}`,
    cold.every(
      (c) =>
        c.status === 200 &&
        c.body.partial === false &&
        Object.values(c.body.upstreams).every((u) => u.source === "upstream" && u.status === "ok") &&
        c.body.user_id === t.a.id &&
        profileOf(c) === t.a.id,
    ),
    `last: ${src(last(cold))}; total ${last(cold).body.total_ms} ms`,
    timing(cold),
  );

  // 3. Same request without refresh: profile and feed (the mock sends
  //    max-age) come from the cache; inbox and stats (no-store) are live.
  const warm = await reps(t.a.jwt, "");
  add(
    3,
    `cache hit on the next call: profile + feed from cache, inbox + stats live, x${t.reps}`,
    warm.every(
      (c) =>
        c.status === 200 &&
        c.body.partial === false &&
        c.body.cache.read === "hit" &&
        c.body.upstreams.profile.source === "cache" &&
        c.body.upstreams.feed.source === "cache" &&
        c.body.upstreams.inbox.source === "upstream" &&
        c.body.upstreams.stats.source === "upstream",
    ),
    `last: ${src(last(warm))}; cache read ${last(warm).body.cache.read_ms} ms`,
    { ...timing(warm), cache_read_ms_median: median(warm.map((c) => c.body.cache.read_ms)) },
  );

  // 4. One upstream slower than the per-call timeout: partial, and on time.
  const slow = await reps(t.a.jwt, "slow=stats");
  const tmo = last(slow).body.timeout_ms;
  add(
    4,
    `stats slow (3 s) past the ${tmo} ms per-call timeout: partial, the rest returned, x${t.reps}`,
    slow.every(
      (c) =>
        c.status === 200 &&
        c.body.partial === true &&
        c.body.upstreams.stats.status === "timeout" &&
        c.body.data.stats === null &&
        ok(c, ["profile", "feed", "inbox"]) &&
        c.body.upstreams.stats.ms >= c.body.timeout_ms &&
        c.body.total_ms < c.body.timeout_ms + 500,
    ),
    `last: ${src(last(slow))}; total ${last(slow).body.total_ms} ms`,
    { ...timing(slow), timeout_ms: tmo, stats_ms_median: median(slow.map((c) => c.body.upstreams.stats.ms)) },
  );

  // 5. One upstream failing: partial, the error reported for that upstream.
  const fail = await reps(t.a.jwt, "fail=feed");
  add(
    5,
    `feed failing (503): partial, the rest returned, x${t.reps}`,
    fail.every(
      (c) =>
        c.status === 200 &&
        c.body.partial === true &&
        c.body.upstreams.feed.status === "error" &&
        c.body.upstreams.feed.http === 503 &&
        c.body.data.feed === null &&
        ok(c, ["profile", "inbox", "stats"]),
    ),
    `last: ${src(last(fail))}; total ${last(fail).body.total_ms} ms`,
    timing(fail),
  );

  // 6. Everything failing: 502, same JSON shape.
  const all = await callFanout(t, t.a.jwt, "fail=profile,feed,inbox,stats");
  add(
    6,
    "every upstream failing: http 502 with the per-upstream report",
    all.status === 502 && all.body.partial === true && Object.values(all.body.data ?? {}).every((d) => d === null),
    `http ${all.status}; ${src(all)}`,
  );

  // 7. User b never gets user a's cached data. Checked on the data itself
  //    (the profile carries the user id it was generated for), so it holds
  //    whether b's own cache is cold or warm from an earlier run.
  const bCall = await callFanout(t, t.b.jwt, "");
  add(
    7,
    "a second user gets their own data, never the first user's cached rows",
    bCall.status === 200 && bCall.body.user_id === t.b.id && profileOf(bCall) === t.b.id,
    `user_id is b=${bCall.body.user_id === t.b.id}; profile.user_id is b=${profileOf(bCall) === t.b.id} (source ${bCall.body.upstreams?.profile?.source}); cache ${bCall.body.cache?.read}`,
  );

  // 8. A user cannot write the cache or reach the table through the Data API.
  const rest = (path: string, init: RequestInit = {}) =>
    fetch(`${t.restUrl}/${path}`, {
      ...init,
      headers: {
        apikey: t.publishableKey,
        Authorization: `Bearer ${t.a.jwt}`,
        "Content-Type": "application/json",
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const put = await rest("rpc/fanout_cache_put", {
    method: "POST",
    body: JSON.stringify({ p_user: t.a.id, p_entries: [{ endpoint: "stats", body: { count: 999999 }, ttl_s: 3600 }] }),
  });
  const putBody = (await put.text()).slice(0, 200);
  const table = await rest("fanout_cache?select=*", { headers: { "Accept-Profile": "private" } });
  const tableBody = (await table.text()).slice(0, 200);
  const own = await rest("rpc/fanout_cache_get", { method: "POST", body: JSON.stringify({ p_endpoints: ["profile", "feed", "inbox", "stats"] }) });
  const ownRows = own.ok ? ((await own.json()) as { endpoint: string }[]) : [];
  const ownList = ownRows.map((r) => r.endpoint).sort().join(",");
  const code = (s: string) => s.match(/"code":"[^"]+"/)?.[0] ?? s.slice(0, 80);
  // b cached profile + feed in step 7, so a leak through the read RPC
  // would show each endpoint twice.
  add(
    8,
    "the cache is service_role-write only, not exposed as a table, and the read RPC returns only the caller's rows",
    put.status >= 400 && putBody.includes("42501") && table.status >= 400 && own.status === 200 && ownList === "feed,profile",
    `put as user http ${put.status} (${code(putBody)}); private table http ${table.status} (${code(tableBody)}); own rows via get: ${ownList || "none"}`,
  );

  return out;
}
