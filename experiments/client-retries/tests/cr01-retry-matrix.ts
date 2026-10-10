/**
 * CR01 - supabase-js PostgREST retry matrix, through a fault-injecting proxy
 * in front of one throwaway project's REST URL.
 *
 * The documented policy (public changelog 45071, docs "automatic retries in
 * supabase-js", supabase-js >= 2.102.0): GET and HEAD that meet a 520, a 503 or
 * a network error are retried up to 3 times at 1, 2, 4 s; each retry carries
 * `X-Retry-Count`; POST/PATCH/PUT/DELETE are never retried; opt out per client
 * or per query. This module measures that policy on the wire (what reaches the
 * proxy, with which header, when) and probes the edges the docs do not state:
 * 525 and the other 5xx, Retry-After, the option name that disables retries,
 * and whether the client times out at all.
 *
 *   CR01-control  provision + fixture, direct GET 200 through the proxy
 *   CR01a1-a6     GET: 503/520/525/other statuses/reset/Retry-After
 *   CR01b1-b3     non-GET and RPC/HEAD variants
 *   CR01c1-c4     opt-outs (`.retry(false)`, `db.retry`, `db.retryEnabled`)
 *   CR01d1-d5     timeouts: none by default; `db.timeout`; `AbortSignal`
 *   CR01e         the real platform 503 PGRST002 (Data API schema off)
 *   CR01f         what the gateway's edge_logs record of those requests
 *
 * Deletes its project in `finally`. Synthetic faults never reach the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { logsQuery } from "../../../harness/src/platform.js";
import { always, firstN, startFaultProxy, type Action, type FaultProxy, type Script } from "../lib/faultproxy.js";
import { client, flat, sleep, timed, wire, SB_VERSION, type ClientOpts, type Outcome } from "../lib/probe.js";
import { destroy, provision, type Provisioned } from "../lib/project.js";

const st = (status: number, extra: Partial<Extract<Action, { kind: "status" }>> = {}): Action => ({ kind: "status", status, ...extra });
const pgrst503 = st(503, { body: JSON.stringify({ code: "PGRST002", message: "injected" }) });

const mod: TestModule = {
  id: "CR01",
  title: "supabase-js PostgREST retries through a fault proxy",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "CR01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const results: TestResult[] = [];
    let p: Provisioned | undefined;
    let ref = "";
    let proxy: FaultProxy | undefined;

    try {
      const made = await provision(ctx, "cr01");
      if ("error" in made) {
        ref = made.ref ?? "";
        results.push({ id: "CR01-control", title: "CR01-control: provision", status: "fail", detail: made.error });
        return results;
      }
      p = made;
      ref = p.ref;
      const key = p.keys.anon;
      proxy = await startFaultProxy(p.baseUrl);
      const px = proxy;
      const mk = (opts: ClientOpts = {}) => client(px.url, key, opts);

      // One case = one script, one call, the proxy's view of it.
      async function run(
        id: string,
        title: string,
        script: Script,
        call: (c: ReturnType<typeof mk>) => PromiseLike<{ error: { code?: string; message?: string; name?: string } | null; status: number }>,
        o: { opts?: ClientOpts; expectAttempts?: number; expectOk?: boolean; note?: string; extra?: Record<string, number | string> } = {},
      ): Promise<{ out: Outcome; w: ReturnType<typeof wire> }> {
        px.reset();
        px.setScript(script);
        const out = await timed(() => call(mk(o.opts)));
        const w = wire(px);
        const met = (o.expectAttempts === undefined || w.attempts === o.expectAttempts) && (o.expectOk === undefined || out.ok === o.expectOk);
        results.push({
          id,
          title: `${id}: ${title}`,
          status: o.expectAttempts === undefined && o.expectOk === undefined ? "info" : met ? "pass" : "fail",
          detail:
            `attempts=${w.attempts} wire=${w.wire} rc=[${w.retryCounts}] gaps=[${w.gapsMs}] status=${out.status} ${out.code} ${out.elapsedMs}ms` +
            (met ? "" : ` (expected attempts=${o.expectAttempts} ok=${o.expectOk})`),
          measurements: { "supabase-js": SB_VERSION, ...flat("r", out, w), ...(o.extra ?? {}) },
        });
        return { out, w };
      }
      const sel = (c: ReturnType<typeof mk>) => c.from("cr_probe").select("id").order("id");

      results.push({
        id: "CR01-control",
        title: "CR01-control: provision + direct GET through the proxy",
        status: "info",
        measurements: { provision_s: p.provisionS, "supabase-js": SB_VERSION, runtime: `bun ${Bun.version}` },
      });
      await run("CR01-control-get", "pass-through GET returns the seeded rows", always({ kind: "pass" }), (c) => sel(c), { expectAttempts: 1, expectOk: true });

      // ---------------- A: GET ----------------
      await run("CR01a1", "GET 503 once then pass", firstN(1, pgrst503), (c) => sel(c), { expectAttempts: 2, expectOk: true });
      await run("CR01a2", "GET 503 always", always(pgrst503), (c) => sel(c), { expectAttempts: 4, expectOk: false });
      await run("CR01a3", "GET 520 always", always(st(520)), (c) => sel(c), { expectAttempts: 4, expectOk: false });

      // Statuses outside the documented set: each should be one attempt.
      const others: Record<string, number | string> = {};
      let othersOk = true;
      for (const code of [525, 502, 504, 500, 429, 408, 521, 522, 524]) {
        px.reset();
        px.setScript(always(st(code)));
        const o = await timed(() => sel(mk()));
        const w = wire(px);
        others[`s${code}_attempts`] = w.attempts;
        others[`s${code}_elapsed_ms`] = o.elapsedMs;
        if (w.attempts !== 1) othersOk = false;
      }
      results.push({
        id: "CR01a4",
        title: "CR01a4: GET answered 525/502/504/500/429/408/521/522/524 is not retried",
        status: othersOk ? "pass" : "fail",
        detail: othersOk ? "1 attempt for every status in the list" : "at least one status was retried",
        measurements: others,
      });

      await run("CR01a5", "GET connection reset always", always({ kind: "reset" }), (c) => sel(c), { expectAttempts: 4, expectOk: false });

      // Retry-After: documented only in a code comment ("signals retry via Retry-After").
      await run("CR01a6a", "503 + Retry-After: 2, then pass", firstN(1, st(503, { headers: { "retry-after": "2" } })), (c) => sel(c), { expectOk: true });
      await run("CR01a6b", "503 + Retry-After: 0, then pass", firstN(1, st(503, { headers: { "retry-after": "0" } })), (c) => sel(c), { expectOk: true });
      await run(
        "CR01a6c",
        "503 + Retry-After as an HTTP date, then pass",
        firstN(1, st(503, { headers: { "retry-after": new Date(Date.now() + 5000).toUTCString() } })),
        (c) => sel(c),
        { expectOk: true },
      );
      await run("CR01a6d", "503 + Retry-After: 40 (above the 30 s backoff cap), then pass", firstN(1, st(503, { headers: { "retry-after": "40" } })), (c) => sel(c), { expectOk: true });

      // ---------------- B: non-GET ----------------
      for (const [tag, action] of [
        ["503", pgrst503],
        ["520", st(520)],
        ["reset", { kind: "reset" } as Action],
      ] as const) {
        await run(`CR01b1-${tag}`, `POST insert answered ${tag}`, always(action), (c) => c.from("cr_writes").insert({ tag: `b1-${tag}` }), { expectAttempts: 1, expectOk: false });
      }
      await run("CR01b2-patch", "PATCH answered 503", always(pgrst503), (c) => c.from("cr_writes").update({ tag: "x" }).eq("tag", "none"), { expectAttempts: 1, expectOk: false });
      await run("CR01b2-delete", "DELETE answered 503", always(pgrst503), (c) => c.from("cr_writes").delete().eq("tag", "none"), { expectAttempts: 1, expectOk: false });
      await run("CR01b2-upsert", "upsert (POST) answered 503", always(pgrst503), (c) => c.from("cr_probe").upsert({ id: 1, note: "one" }), { expectAttempts: 1, expectOk: false });
      await run("CR01b3-rpc-post", "rpc() default (POST) answered 503", always(pgrst503), (c) => c.rpc("cr_ping"), { expectAttempts: 1, expectOk: false });
      await run("CR01b3-rpc-get", "rpc() with get:true answered 503", always(pgrst503), (c) => c.rpc("cr_ping", {}, { get: true }), { expectAttempts: 4, expectOk: false });
      await run(
        "CR01b3-head",
        "select head:true count (HEAD) answered 503",
        always(pgrst503),
        (c) => c.from("cr_probe").select("*", { count: "exact", head: true }),
        { expectAttempts: 4, expectOk: false },
      );

      // ---------------- C: opt-outs ----------------
      await run("CR01c1", ".retry(false) on the query, 503 always", always(pgrst503), (c) => sel(c).retry(false), { expectAttempts: 1, expectOk: false });
      await run("CR01c2", "createClient db.retry=false, 503 always", always(pgrst503), (c) => sel(c), { opts: { db: { retry: false } }, expectAttempts: 1, expectOk: false });
      await run(
        "CR01c3",
        "createClient db.retryEnabled=false (the changelog's JS option name), 503 always",
        always(pgrst503),
        (c) => sel(c),
        // retryEnabled is not a declared option; cast to pass it anyway.
        { opts: { db: { retryEnabled: false } as unknown as { retry: boolean } } },
      );
      await run(
        "CR01c4",
        "db.retry=false overridden by .retry(true) on the query, 503 always",
        always(pgrst503),
        (c) => sel(c).retry(true),
        { opts: { db: { retry: false } } },
      );

      // ---------------- D: timeouts ----------------
      await run("CR01d1", "no timeout: GET delayed 3 s", always({ kind: "pass", delayMs: 3000 }), (c) => sel(c), { expectAttempts: 1, expectOk: true });
      await run("CR01d2", "no timeout: GET delayed 10 s", always({ kind: "pass", delayMs: 10_000 }), (c) => sel(c), { expectAttempts: 1, expectOk: true });
      await run("CR01d3", "db.timeout=2000, GET delayed 3 s", always({ kind: "pass", delayMs: 3000 }), (c) => sel(c), { opts: { db: { timeout: 2000 } }, expectAttempts: 1, expectOk: false });
      await run("CR01d4", "db.timeout=2000, 503 always (is the timeout per attempt or per call?)", always(pgrst503), (c) => sel(c), { opts: { db: { timeout: 2000 } }, expectOk: false });
      // The signal the supabase docs recommend, created inline: nothing else holds a listener on it.
      await run(
        "CR01d5a",
        ".abortSignal(AbortSignal.timeout(5000)) created inline, 503 always (should abort during the 3 s to 7 s backoff)",
        always(pgrst503),
        (c) => sel(c).abortSignal(AbortSignal.timeout(5000)),
        { expectOk: false },
      );
      await run(
        "CR01d5b",
        ".abortSignal(controller.signal) with setTimeout(abort, 5000), 503 always",
        always(pgrst503),
        (c) => {
          const ac = new AbortController();
          setTimeout(() => ac.abort(), 5000);
          return sel(c).abortSignal(ac.signal);
        },
        { expectOk: false },
      );
      await run(
        "CR01d5c",
        "AbortSignal.timeout(5000) with an abort listener attached at creation, 503 always",
        always(pgrst503),
        (c) => {
          const sig = AbortSignal.timeout(5000);
          sig.addEventListener("abort", () => {});
          return sel(c).abortSignal(sig);
        },
        { expectOk: false },
      );
      await run(
        "CR01d6",
        "db.timeout=2000, first attempt 503 then the retry hangs",
        (r) => (r.k === 0 ? pgrst503 : { kind: "hang" }),
        (c) => sel(c),
        { opts: { db: { timeout: 2000 } }, expectOk: false },
      );

      // d7: inline AbortSignal.timeout, first attempt 503, the retry hangs. If the
      // timer was lost during the backoff nothing ever ends the call; cap the
      // observation at 9 s.
      {
        px.reset();
        px.setScript((r) => (r.k === 0 ? pgrst503 : { kind: "hang" }));
        const t0 = performance.now();
        const settled = await Promise.race([
          timed(() => mk().from("cr_probe").select("id").abortSignal(AbortSignal.timeout(3000))).then((o) => ({ pending: false as const, o })),
          sleep(9000).then(() => ({ pending: true as const, o: undefined })),
        ]);
        const w = wire(px);
        results.push({
          id: "CR01d7",
          title: "CR01d7: inline AbortSignal.timeout(3000), first attempt 503, then the retry hangs",
          status: "info",
          detail: settled.pending
            ? `still pending at ${Math.round(performance.now() - t0)} ms, wire=${w.wire} (the 3000 ms deadline never ended the call)`
            : `settled after ${settled.o?.elapsedMs} ms, status ${settled.o?.status} ${settled.o?.code}, wire=${w.wire}`,
          measurements: { pending_at_9s: settled.pending ? 1 : 0, wire: w.wire, elapsed_ms: settled.o?.elapsedMs ?? -1 },
        });
        px.reset();
        px.setScript(always({ kind: "pass" }));
      }

      // ---------------- E: the real platform 503 ----------------
      await realOff(ctx, p, px, mk, results);

      // ---------------- F: edge_logs ----------------
      await edgeLogs(ctx, p, results);
    } catch (e) {
      results.push({ id: "CR01-error", title: "CR01: module threw", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await proxy?.stop().catch(() => null);
      const code = await destroy(ctx, ref);
      results.push({ id: "CR01-teardown", title: "CR01-teardown: project deleted", status: ref ? (code >= 200 && code < 300 ? "info" : "fail") : "info", measurements: { delete_status: code } });
    }
    return results;
  },
};

interface PgrstConfig {
  db_schema: string;
  max_rows: number;
  db_extra_search_path: string;
  db_pool: number | null;
}

async function realOff(ctx: Ctx, p: Provisioned, px: FaultProxy, mk: (o?: ClientOpts) => ReturnType<typeof client>, results: TestResult[]) {
  const g = await mgmt(p.pctx, "GET", `/projects/${p.ref}/postgrest`);
  const j = (g.json ?? {}) as Record<string, unknown>;
  const base: PgrstConfig = {
    db_schema: String(j.db_schema ?? "public"),
    max_rows: Number(j.max_rows ?? 1000),
    db_extra_search_path: String(j.db_extra_search_path ?? ""),
    db_pool: (j.db_pool as number | null) ?? null,
  };
  const patch = (db_schema: string) =>
    mgmt(p.pctx, "PATCH", `/projects/${p.ref}/postgrest`, {
      db_schema,
      max_rows: base.max_rows,
      db_extra_search_path: base.db_extra_search_path,
      ...(base.db_pool !== null ? { db_pool: base.db_pool } : {}),
    });
  const direct = async () => {
    const r = await fetch(`${p.baseUrl}/rest/v1/cr_probe?select=id`, { headers: { apikey: p.keys.anon }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    return r?.status ?? 0;
  };
  try {
    const off = await patch("");
    let seen503 = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      if ((await direct()) === 503) {
        seen503 = true;
        break;
      }
      await sleep(1000);
    }
    if (off.status !== 200 || !seen503) {
      results.push({ id: "CR01e", title: "CR01e: real 503 PGRST002", status: "fail", detail: `off PATCH ${off.status}, 503 seen=${seen503}` });
      return;
    }
    px.reset();
    px.setScript(always({ kind: "pass" }));
    // Default client, GET, real 503s.
    const c = mk();
    const get = await timed(() => c.from("cr_probe").select("id").neq("id", 987654));
    const wg = wire(px);
    const ras = px.governed().map((s) => s.upstreamRetryAfter ?? "-").join(",");
    // How long each real answer took the proxy to produce: if a gap between
    // attempts is about the previous answer's duration, the client waited ~0.
    const dones = px.governed().map((s) => s.doneMs ?? -1).join(",");
    results.push({
      id: "CR01e1",
      title: "CR01e1: GET against the real Data-API-off 503 PGRST002",
      status: "info",
      detail: `attempts=${wg.attempts} rc=[${wg.retryCounts}] gaps=[${wg.gapsMs}] upstream Retry-After=[${ras}] ${get.status} ${get.code} ${get.elapsedMs}ms`,
      measurements: { ...flat("g", get, wg), upstream_retry_after: ras, upstream_answer_ms: dones },
    });
    px.reset();
    const post = await timed(() => mk().from("cr_writes").insert({ tag: "e2" }));
    const wp = wire(px);
    results.push({
      id: "CR01e2",
      title: "CR01e2: POST insert against the real 503 PGRST002",
      status: wp.attempts === 1 ? "pass" : "fail",
      detail: `attempts=${wp.attempts} wire=${wp.wire} ${post.status} ${post.code}`,
      measurements: flat("p", post, wp),
    });
    px.reset();
    const nr = await timed(() => mk().from("cr_probe").select("id").neq("id", 987655).retry(false));
    results.push({
      id: "CR01e3",
      title: "CR01e3: GET .retry(false) against the real 503 PGRST002",
      status: wire(px).attempts === 1 ? "pass" : "fail",
      measurements: flat("n", nr, wire(px)),
    });
  } finally {
    await patch(base.db_schema).catch(() => null);
    const t0 = Date.now();
    let code = 0;
    while (Date.now() - t0 < 90_000 && code !== 200) {
      code = await direct();
      if (code !== 200) await sleep(1000);
    }
    results.push({ id: "CR01e-restore", title: "CR01e-restore: Data API back", status: code === 200 ? "info" : "fail", measurements: { restore_s: Math.round((Date.now() - t0) / 1000), final_status: code } });
  }
}

/**
 * Do the gateway logs show the retry header, and how many requests did the real
 * 503 phase produce? Best-effort: logs lag and the endpoint is rate-limited, so
 * a miss is data. The unified `logs` table's column is `source`, not
 * `source_name` (medium-serverless MS05).
 *
 * The real-503 phase marked its GETs with `id=neq.987654` (default client, 4
 * attempts expected) and `id=neq.987655` (`.retry(false)`, 1 expected).
 */
async function edgeLogs(_ctx: Ctx, p: Provisioned, results: TestResult[]) {
  const q =
    "select timestamp, log_attributes['request.method'] as m, log_attributes['request.search'] as s, " +
    "log_attributes['response.status_code'] as sc, toString(log_attributes) as a " +
    "from logs where source = 'edge_logs' and log_attributes['request.search'] like '%id=neq.98765%' order by timestamp asc limit 50";
  let rows: { timestamp?: string; m?: string; s?: string; sc?: string; a?: string }[] = [];
  let err = "";
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    const r = await logsQuery(p.pctx, q, 1);
    rows = r.rows as unknown as typeof rows;
    err = r.error;
    if (rows.length >= 5) break;
    await sleep(20_000);
  }
  const byMarker = (m: string) => rows.filter((r) => (r.s ?? "").includes(m));
  const retryText = rows.filter((r) => /retry/i.test(r.a ?? "")).length;
  const hdrKeys = new Set<string>();
  for (const r of rows) for (const m of (r.a ?? "").matchAll(/'request\.headers\.([a-z0-9_]+)'/g)) hdrKeys.add(m[1] ?? "");
  const statuses = (m: string) => byMarker(m).map((r) => r.sc ?? "?").join(",") || "-";
  results.push({
    id: "CR01f",
    title: "CR01f: gateway edge_logs for the real-503 GETs",
    status: "info",
    detail: rows.length
      ? `rows=${rows.length}; default client rows=${byMarker("987654").length} (${statuses("987654")}); .retry(false) rows=${byMarker("987655").length}; rows mentioning retry=${retryText}`
      : `no rows after ${Math.round((Date.now() - t0) / 1000)}s ${err}`,
    measurements: {
      edge_rows_total: rows.length,
      edge_rows_default_client: byMarker("987654").length,
      edge_statuses_default_client: statuses("987654"),
      edge_rows_retry_false: byMarker("987655").length,
      rows_mentioning_retry: retryText,
      request_header_attrs_seen: [...hdrKeys].sort().join(",") || "-",
      waited_s: Math.round((Date.now() - t0) / 1000),
    },
  });
}

export default mod;
