/**
 * CR02 - validate a client policy the built-in retries do not provide:
 *
 *   (1) a deadline (`AbortSignal.timeout`) plus ONE hedged/extra GET attempt, so
 *       a slow or 525-ing path costs the caller a bounded time and a bounded
 *       number of requests;
 *   (2) on a 401, `auth.refreshSession()` once and repeat the request once.
 *
 * Same proxy rig as CR01, in front of one throwaway project. Synthetic faults
 * (delay, 525, hang, 401) come from the proxy; the 401 case CR02h4 uses a REAL
 * 401: a session whose access token has a corrupted signature.
 *
 *   CR02a      baseline: default client, first request delayed 10 s
 *   CR02b-f    hedgedGet: slow first, 525 first, 525 always, hang, stacking
 *              with the built-in retries
 *   CR02g1-g2  why hedging is GET-only: a hedged POST writes twice; a hedged
 *              idempotent upsert does not
 *   CR02h1-h5  refreshThenRetry: injected 401 once / always, revoked session,
 *              a real 401, five parallel 401s
 *
 * Deletes its project in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { always, firstN, startFaultProxy, type Action, type FaultProxy } from "../lib/faultproxy.js";
import { hedgedGet, refreshThenRetry, type Resp } from "../lib/policy.js";
import { client, sleep, timed, wire, SB_VERSION } from "../lib/probe.js";
import { destroy, makeUser, provision, writeCount, type Provisioned } from "../lib/project.js";

const st = (status: number, body?: string): Action => ({ kind: "status", status, body });
const pgrst303 = st(401, JSON.stringify({ code: "PGRST303", message: "JWT expired (injected)" }));

const mod: TestModule = {
  id: "CR02",
  title: "client policy: deadline + one hedged GET, refresh-then-retry on 401",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "CR02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    let ref = "";
    let proxy: FaultProxy | undefined;
    let p: Provisioned | undefined;
    try {
      const made = await provision(ctx, "cr02");
      if ("error" in made) {
        ref = made.ref ?? "";
        results.push({ id: "CR02-control", title: "CR02-control: provision", status: "fail", detail: made.error });
        return results;
      }
      p = made;
      ref = p.ref;
      const px = (proxy = await startFaultProxy(p.baseUrl));
      const anon = p.keys.anon;
      const mk = (opts = {}) => client(px.url, anon, opts);
      results.push({ id: "CR02-control", title: "CR02-control: provision", status: "info", measurements: { provision_s: p.provisionS, "supabase-js": SB_VERSION, runtime: `bun ${Bun.version}` } });

      // A GET as the policy sees it: built-in retries off unless asked.
      const sel = (c: ReturnType<typeof mk>, keepBuiltin = false) => (sig: AbortSignal) => {
        const q = c.from("cr_probe").select("id").abortSignal(sig);
        return (keepBuiltin ? q : q.retry(false)) as unknown as PromiseLike<Resp>;
      };

      // ---------- CR02a: baseline ----------
      px.reset();
      px.setScript(firstN(1, { kind: "pass", delayMs: 10_000 }));
      const base = await timed(() => mk().from("cr_probe").select("id"));
      results.push({
        id: "CR02a",
        title: "CR02a: baseline default client, first request delayed 10 s",
        status: "info",
        detail: `${base.elapsedMs} ms, wire ${wire(px).wire}`,
        measurements: { elapsed_ms: base.elapsedMs, wire: wire(px).wire, ok: base.ok ? 1 : 0 },
      });

      // ---------- hedgedGet cases ----------
      const hedge = async (id: string, title: string, script: Parameters<FaultProxy["setScript"]>[0], o: { timeoutMs: number; hedgeAfterMs: number; keepBuiltin?: boolean }, expect: (r: Awaited<ReturnType<typeof hedgedGet>>, ms: number) => string) => {
        px.reset();
        px.setScript(script);
        const c = mk();
        const t0 = performance.now();
        const r = await hedgedGet(sel(c, o.keepBuiltin), o);
        const ms = Math.round(performance.now() - t0);
        await sleep(150); // let the proxy see the aborted loser
        const w = wire(px);
        const rows = px.governed();
        const problem = expect(r, ms);
        results.push({
          id,
          title: `${id}: ${title}`,
          status: problem ? "fail" : "pass",
          detail: `started=${r.started} winner=${r.winner} status=${r.status} ${ms} ms wire=${w.wire}` + (problem ? ` (${problem})` : ""),
          measurements: {
            timeout_ms: o.timeoutMs,
            hedge_after_ms: o.hedgeAfterMs,
            elapsed_ms: ms,
            started: r.started,
            winner: r.winner,
            status: r.status,
            ok: r.error === null ? 1 : 0,
            wire: w.wire,
            actions: rows.map((s) => s.action).join(","),
            client_aborted: rows.map((s) => (s.clientAborted ? 1 : 0)).join(","),
          },
        });
      };

      await hedge(
        "CR02b",
        "hedge: first request held 10 s before forwarding, hedge at 1500 ms",
        firstN(1, { kind: "pass", delayMs: 10_000 }),
        { timeoutMs: 5000, hedgeAfterMs: 1500 },
        (r, ms) => (r.error === null && r.winner === 2 && r.started === 2 && ms < 3000 ? "" : "expected hedge to win under 3 s"),
      );
      await hedge("CR02c", "extra attempt: 525 once then pass", firstN(1, st(525)), { timeoutMs: 5000, hedgeAfterMs: 1500 }, (r) => (r.error === null && r.started === 2 ? "" : "expected 2 attempts and success"));
      await hedge("CR02d", "525 always: attempts and time stay bounded", always(st(525)), { timeoutMs: 5000, hedgeAfterMs: 1500 }, (r, ms) => (r.started === 2 && r.status === 525 && ms < 3000 ? "" : "expected 2 attempts, status 525, under 3 s"));
      await hedge("CR02e", "hang always: the deadline ends the call", always({ kind: "hang" }), { timeoutMs: 4000, hedgeAfterMs: 1500 }, (r, ms) => (ms >= 3800 && ms < 5500 && r.error !== null ? "" : "expected failure near the 4000 ms deadline"));
      await hedge("CR02f1", "built-in retries OFF per attempt, 503 always, deadline 6 s", always(st(503)), { timeoutMs: 6000, hedgeAfterMs: 1500 }, () => "");
      await hedge("CR02f2", "built-in retries LEFT ON per attempt, 503 always, deadline 6 s", always(st(503)), { timeoutMs: 6000, hedgeAfterMs: 1500, keepBuiltin: true }, () => "");

      // ---------- CR02g: hedging writes ----------
      const hedgePost = async (id: string, title: string, tag: string, write: (c: ReturnType<typeof mk>) => (sig: AbortSignal) => PromiseLike<Resp>, rowsOf: () => Promise<number>) => {
        px.reset();
        // The server is slow, not the network: forward at once, hold the answer.
        px.setScript(firstN(1, { kind: "pass", delayAfterMs: 4000 }));
        const r = await hedgedGet(write(mk()), { timeoutMs: 8000, hedgeAfterMs: 1500 });
        await sleep(5000); // let the first (aborted-by-client) write finish server-side
        const rows = await rowsOf();
        results.push({
          id,
          title: `${id}: ${title}`,
          status: "info",
          detail: `started=${r.started} winner=${r.winner}; rows with tag ${tag}: ${rows}`,
          measurements: { started: r.started, winner: r.winner, rows_written: rows, wire: wire(px).wire },
        });
      };
      await hedgePost(
        "CR02g1",
        "hedged POST insert (not idempotent), server slow on the first",
        "g1",
        (c) => (sig) => c.from("cr_writes").insert({ tag: "g1" }).abortSignal(sig) as unknown as PromiseLike<Resp>,
        () => writeCount(p!, "g1"),
      );
      await hedgePost(
        "CR02g2",
        "hedged upsert on a primary key (idempotent), server slow on the first",
        "g2",
        (c) => (sig) => c.from("cr_probe").upsert({ id: 100, note: "g2" }).abortSignal(sig) as unknown as PromiseLike<Resp>,
        async () => {
          const r = await (await import("../../../harness/src/platform.js")).sql(p!.pctx, "select count(*)::int as n from public.cr_probe where id = 100");
          return Number(r.rows[0]?.n ?? -1);
        },
      );

      // ---------- refreshThenRetry ----------
      const user = await makeUser(p);
      const signIn = async () => {
        const c = mk();
        px.setScript(always({ kind: "pass" }));
        const { data, error } = await c.auth.signInWithPassword(user);
        if (error || !data.session) throw new Error(`sign-in: ${error?.message}`);
        return { c, session: data.session };
      };
      const authRefreshes = () => px.seen.filter((s) => s.path.includes("/auth/v1/token") && s.path.includes("refresh_token"));
      const authGet = (c: ReturnType<typeof mk>) => () => c.from("cr_probe").select("id").retry(false) as unknown as PromiseLike<Resp>;

      // h1: injected 401 once
      {
        const { c } = await signIn();
        px.reset();
        px.setScript(firstN(1, pgrst303));
        const naive = await timed(() => c.from("cr_probe").select("id").retry(false));
        const nw = wire(px);
        px.reset();
        px.setScript(firstN(1, pgrst303));
        const t0 = performance.now();
        const r = await refreshThenRetry(c, authGet(c));
        const ms = Math.round(performance.now() - t0);
        const rest = px.governed();
        const fps = rest.map((s) => s.authFp);
        const changed = fps.length === 2 && fps[0] !== fps[1] && fps[1] !== "";
        results.push({
          id: "CR02h1",
          title: "CR02h1: injected 401 PGRST303 once: naive vs refresh-then-retry",
          status: naive.status === 401 && r.refreshed && r.error === null && rest.length === 2 && authRefreshes().length === 1 && changed ? "pass" : "fail",
          detail: `naive: status ${naive.status} after ${nw.wire} request; policy: ok=${r.error === null} rest=${rest.length} refresh calls=${authRefreshes().length} new token on retry=${changed} ${ms} ms`,
          measurements: { naive_status: naive.status, naive_rest_wire: nw.wire, policy_ok: r.error === null ? 1 : 0, policy_rest_wire: rest.length, refresh_calls: authRefreshes().length, retry_used_new_token: changed ? 1 : 0, elapsed_ms: ms },
        });
      }
      // h2: 401 always
      {
        const { c } = await signIn();
        px.reset();
        px.setScript(always(pgrst303));
        const r = await refreshThenRetry(c, authGet(c));
        results.push({
          id: "CR02h2",
          title: "CR02h2: 401 on every REST request: the policy stops after one refresh and one retry",
          status: r.status === 401 && px.governed().length === 2 && authRefreshes().length === 1 ? "pass" : "fail",
          detail: `final status ${r.status}, rest=${px.governed().length}, refresh calls=${authRefreshes().length}`,
          measurements: { final_status: r.status, rest_wire: px.governed().length, refresh_calls: authRefreshes().length },
        });
      }
      // h3: session revoked, so the refresh itself fails
      {
        const { c, session } = await signIn();
        const out = await fetch(`${p.baseUrl}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: anon, authorization: `Bearer ${session.access_token}` } });
        px.reset();
        px.setScript(firstN(1, pgrst303));
        const r = await refreshThenRetry(c, authGet(c));
        const rf = authRefreshes();
        results.push({
          id: "CR02h3",
          title: "CR02h3: session revoked server-side, then a 401: the refresh fails and the original 401 is returned",
          status: r.status === 401 && !r.refreshed && px.governed().length === 1 ? "pass" : "fail",
          detail: `logout HTTP ${out.status}; refresh error=${r.refreshError || "-"}; refresh upstream=${rf.map((s) => s.upstreamStatus).join(",")}; rest=${px.governed().length}`,
          measurements: { logout_status: out.status, refresh_error: r.refreshError || "-", refresh_upstream_status: rf.map((s) => s.upstreamStatus ?? 0).join(","), rest_wire: px.governed().length, final_status: r.status },
        });
      }
      // h4: a REAL 401 (access token with a corrupted signature, valid refresh token)
      {
        const { session } = await signIn();
        const bad = `${session.access_token.slice(0, -4)}AAAA`;
        const store = new Map<string, string>();
        const key = "cr-store";
        store.set(key, JSON.stringify({ ...session, access_token: bad }));
        const c = mk({ auth: { persistSession: true, storageKey: key, storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } } });
        px.reset();
        px.setScript(always({ kind: "pass" }));
        const naive = await timed(() => c.from("cr_probe").select("id").retry(false));
        const nCode = naive.code;
        px.reset();
        const r = await refreshThenRetry(c, authGet(c));
        results.push({
          id: "CR02h4",
          title: "CR02h4: real 401 (corrupted access-token signature, valid refresh token): refresh-then-retry recovers",
          status: naive.status === 401 && r.error === null && r.refreshed ? "pass" : "fail",
          detail: `naive status ${naive.status} ${nCode}; policy ok=${r.error === null} refreshed=${r.refreshed} rest=${px.governed().length} refresh calls=${authRefreshes().length}`,
          measurements: { naive_status: naive.status, naive_code: nCode, policy_ok: r.error === null ? 1 : 0, rest_wire: px.governed().length, refresh_calls: authRefreshes().length },
        });
      }
      // h5: five parallel requests, all 401 once
      {
        const { c } = await signIn();
        px.reset();
        px.setScript(firstN(5, pgrst303));
        const rs = await Promise.all([1, 2, 3, 4, 5].map(() => refreshThenRetry(c, authGet(c))));
        const okN = rs.filter((r) => r.error === null).length;
        results.push({
          id: "CR02h5",
          title: "CR02h5: five parallel requests each get one 401: how many refresh calls reach the Auth server",
          status: "info",
          detail: `ok ${okN}/5, refresh calls=${authRefreshes().length}, rest wire=${px.governed().length}`,
          measurements: { ok_of_5: okN, refresh_calls: authRefreshes().length, rest_wire: px.governed().length },
        });
      }
    } catch (e) {
      results.push({ id: "CR02-error", title: "CR02: module threw", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await proxy?.stop().catch(() => null);
      const code = await destroy(ctx, ref);
      results.push({ id: "CR02-teardown", title: "CR02-teardown: project deleted", status: "info", measurements: { delete_status: code } });
    }
    return results;
  },
};

export default mod;
