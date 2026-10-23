/**
 * EF14 - the nested-call budget as documented since 2026-09-23: 30
 * function-to-function requests per trace within a 60-second window, per
 * trace rather than per project (https://supabase.com/docs/guides/functions/
 * recursive-functions; changed from "~5000 per minute" by
 * supabase/supabase#50806). EF10 measured against the old figure with chains
 * of depth 2, two nested calls per trace, so it could not reach a per-trace
 * budget of 30.
 *
 * One function, `pvlab-ef14-hop`, in three modes:
 *   leaf   answers at once, and reports the names of the request headers it
 *          received and the trace id field of any `traceparent`
 *   fan    makes N calls to itself in leaf mode, sequentially or all at once,
 *          optionally pausing after call K; records each call's status or the
 *          thrown error's name, message and `retryAfterMs`
 *   chain  calls itself with depth-1 until depth 0, optionally making k leaf
 *          calls at each hop first; reports how deep the chain got, the leaf
 *          calls that went through or were refused, and the error that stopped it
 *
 *   EF14a  control: fan of 5, sequential -> all 200
 *   EF14b  fan of 40, sequential, three traces back to back: index of the
 *          first refused call per trace, refusal verbatim. The second and
 *          third traces start right after the first was refused, so a fresh
 *          budget per trace shows as the same index three times.
 *   EF14c  two traces at once, fan of 25 each (50 calls, over 30 if the
 *          budget were shared), three rounds
 *   EF14d  fan of 40, all 40 in parallel, three traces
 *   EF14e  chain of depth 40 (each hop one nested call in one trace), three
 *          traces
 *   EF14f  window: fan of 36 with a 62 s pause after call 30, three traces
 *          in parallel - do calls 31-36 go through once the 60 s window has
 *          passed since the first call?
 *   EF14g  a client-supplied `traceparent`: two outer invocations carrying
 *          the same trace id, fan of 20 each, one after the other; refused
 *          calls in the second say the budget followed the client's trace id
 *   EF14h  a chain whose hops each fan out (depth 5, 10 leaf calls per hop,
 *          65 nested calls in one chain): separates a budget shared along the
 *          chain from one per calling invocation. Added after the first run
 *          (2026-10-23) found EF14e's depth-40 chain never refused.
 *
 * The outer invocation is the client's request to the function; it is not a
 * function-to-function call and the docs do not count it.
 *
 * DESTRUCTIVE: deploys one function under pvlab-ef14-, deletes in finally.
 * A few hundred invocations, about four minutes (EF14f waits 62 s).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { RUNTIME } from "../lib/docs";
import { cleanupPrefix, deployViaApi, invoke, invokeWhenLive } from "../lib/ef";

const P = "pvlab-ef14-";
const REPS = 3;

const SRC = `
const SELF = Deno.env.get("SUPABASE_URL") + "/functions/v1/${P}hop";
const KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const H = { apikey: KEY, Authorization: "Bearer " + KEY };
function traceId(req) {
  const tp = req.headers.get("traceparent") ?? "";
  return tp.split("-")[1] ?? "";
}
async function call(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { headers: H });
    const text = await r.text();
    return { status: r.status, ms: Math.round(performance.now() - t0), body: r.status === 200 ? undefined : text.slice(0, 200), text };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), err: (e && e.name) || "Error", msg: String(e && e.message || e).slice(0, 200), retryAfterMs: e && e.retryAfterMs !== undefined ? e.retryAfterMs : null };
  }
}
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const mode = u.searchParams.get("mode") ?? "leaf";
  if (mode === "leaf") {
    const names = [...req.headers.keys()].filter((k) => k !== "apikey" && k !== "authorization").sort();
    return Response.json({ mode, trace: traceId(req), headers: names });
  }
  if (mode === "chain") {
    // Each hop makes k leaf calls, then one call to the next hop; the bottom
    // hop makes its k leaf calls and stops. Counts add up the chain.
    const depth = Number(u.searchParams.get("depth") ?? "0");
    const k = Number(u.searchParams.get("k") ?? "0");
    let leafOk = 0, leafRefused = 0, firstLeafRefusal = null;
    for (let i = 0; i < k; i++) {
      const r = await call(SELF + "?mode=leaf");
      if (r.status === 200) leafOk++; else { leafRefused++; if (!firstLeafRefusal) firstLeafRefusal = r.err ? r.err + ": " + r.msg : "HTTP " + r.status; }
    }
    if (depth <= 0) return Response.json({ reached: 0, stop: "bottom", leafOk, leafRefused, firstLeafRefusal });
    const r = await call(SELF + "?mode=chain&k=" + k + "&depth=" + (depth - 1));
    if (r.status !== 200) return Response.json({ reached: 0, stop: r.err ? r.err + ": " + r.msg : "HTTP " + r.status + " " + (r.body ?? ""), retryAfterMs: r.retryAfterMs ?? null, leafOk, leafRefused, firstLeafRefusal });
    let inner = {};
    try { inner = JSON.parse(r.text); } catch { inner = { reached: 0, stop: "unparsed inner" }; }
    return Response.json({ reached: (inner.reached ?? 0) + 1, stop: inner.stop, retryAfterMs: inner.retryAfterMs ?? null, leafOk: leafOk + (inner.leafOk ?? 0), leafRefused: leafRefused + (inner.leafRefused ?? 0), firstLeafRefusal: firstLeafRefusal ?? inner.firstLeafRefusal ?? null });
  }
  // fan
  const n = Number(u.searchParams.get("n") ?? "5");
  const parallel = u.searchParams.get("parallel") === "1";
  const pauseAfter = Number(u.searchParams.get("pauseAfter") ?? "0");
  const pauseMs = Number(u.searchParams.get("pauseMs") ?? "0");
  const T0 = Date.now();
  const calls = [];
  if (parallel) {
    const rs = await Promise.all(Array.from({ length: n }, () => call(SELF + "?mode=leaf")));
    rs.forEach((r, i) => calls.push({ i: i + 1, ...r }));
  } else {
    for (let i = 1; i <= n; i++) {
      const r = await call(SELF + "?mode=leaf");
      calls.push({ i, at_ms: Date.now() - T0, ...r });
      if (pauseAfter && i === pauseAfter) await new Promise((res) => setTimeout(res, pauseMs));
    }
  }
  let leafTrace = "";
  let leafHeaders = [];
  for (const c of calls) {
    if (c.status === 200 && c.text) {
      try { const j = JSON.parse(c.text); leafTrace = j.trace; leafHeaders = j.headers; } catch {}
      break;
    }
  }
  for (const c of calls) delete c.text;
  const refused = calls.filter((c) => c.status !== 200);
  return Response.json({ mode, n, parallel, outer_trace: traceId(req), leaf_trace: leafTrace, leaf_headers: leafHeaders, ok: n - refused.length, first_refused: refused[0]?.i ?? 0, refusal: refused[0] ?? null, calls });
});
`;

interface Fan {
  status: number;
  ok: number;
  firstRefused: number;
  refusal: string;
  retryAfterMs: string;
  outerTrace: string;
  leafTrace: string;
  leafHeaders: string;
  calls: { i: number; status: number; at_ms?: number; err?: string }[];
  raw: string;
}

function refusalText(r: Record<string, unknown> | null | undefined): string {
  if (!r) return "none";
  if (r.err) return `${String(r.err)}: ${String(r.msg ?? "")}`.slice(0, 200);
  return `HTTP ${String(r.status)} ${String(r.body ?? "")}`.slice(0, 200);
}

async function fan(ctx: Ctx, slug: string, q: string, headers?: Record<string, string>): Promise<Fan> {
  const r = await invoke(ctx, slug, { path: `?mode=fan&${q}`, timeoutMs: 140_000, headers });
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    const refusal = j.refusal as Record<string, unknown> | null;
    return {
      status: r.status,
      ok: Number(j.ok ?? 0),
      firstRefused: Number(j.first_refused ?? 0),
      refusal: refusalText(refusal),
      retryAfterMs: refusal ? String(refusal.retryAfterMs ?? "none") : "none",
      outerTrace: String(j.outer_trace ?? ""),
      leafTrace: String(j.leaf_trace ?? ""),
      leafHeaders: (j.leaf_headers as string[] | undefined)?.join(",") ?? "",
      calls: (j.calls as Fan["calls"]) ?? [],
      raw: "",
    };
  } catch {
    return { status: r.status, ok: 0, firstRefused: -1, refusal: "unparsed", retryAfterMs: "none", outerTrace: "", leafTrace: "", leafHeaders: "", calls: [], raw: (r.text || r.error || "").slice(0, 200) };
  }
}

function fanLine(f: Fan): string {
  return f.raw ? `outer ${f.status} ${f.raw}` : `outer ${f.status}, ${f.ok} ok, first refused #${f.firstRefused || "none"}`;
}

/** Statuses of the calls in order, run-length encoded: "200x30,0x10". */
function rle(f: Fan): string {
  const parts: string[] = [];
  let prev = "";
  let n = 0;
  for (const c of f.calls) {
    const k = c.status === 0 ? `err` : String(c.status);
    if (k === prev) n++;
    else {
      if (prev) parts.push(`${prev}x${n}`);
      prev = k;
      n = 1;
    }
  }
  if (prev) parts.push(`${prev}x${n}`);
  return parts.join(",") || "none";
}

const sameTrace = (a: string, b: string) => (a && b ? (a === b ? 1 : 0) : -1);

const mod: TestModule = {
  id: "EF14",
  title: "Nested-call budget per trace (docs: 30 per trace per 60 s)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF14", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const slug = `${P}hop`;
    const docs = RUNTIME.nestedCallsPerTrace;
    try {
      await cleanupPrefix(ctx, P);
      const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SRC }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
      if (dep.status >= 300) return [{ id: "EF14", title: this.title, status: "fail", detail: `deploy HTTP ${dep.status} "${dep.error}"` }];
      const live = await invokeWhenLive(ctx, slug, 90_000, { path: "?mode=leaf", timeoutMs: 30_000 });
      if (live.status !== 200) return [{ id: "EF14", title: this.title, status: "fail", detail: `function not live: ${live.status}` }];

      // EF14a - control.
      const a = await fan(ctx, slug, "n=5");
      out.push({
        id: "EF14a",
        title: "control: fan of 5 sequential calls",
        status: a.status === 200 && a.ok === 5 ? "pass" : "fail",
        detail: `${fanLine(a)}; leaf saw headers ${a.leafHeaders || "?"}`,
        measurements: {
          outer_status: a.status,
          ok: a.ok,
          leaf_header_names: a.leafHeaders || "none",
          outer_has_traceparent: a.outerTrace ? 1 : 0,
          leaf_has_traceparent: a.leafTrace ? 1 : 0,
          leaf_trace_equals_outer: sameTrace(a.outerTrace, a.leafTrace),
        },
      });
      if (a.status !== 200) return out;

      // EF14b - sequential fan of 40, three traces back to back.
      for (let rep = 1; rep <= REPS; rep++) {
        const b = await fan(ctx, slug, "n=40");
        const firstAt = b.calls.find((c) => c.i === b.firstRefused)?.at_ms;
        out.push({
          id: `EF14b${rep}`,
          title: `fan of 40 sequential calls, trace ${rep} of ${REPS} back to back (docs ${docs} per trace)`,
          status: "info",
          detail: `${fanLine(b)}; ${rle(b)}; refusal ${b.refusal}`,
          measurements: {
            docs_per_trace: docs,
            outer_status: b.status,
            ok: b.ok,
            first_refused_call: b.firstRefused,
            first_refused_at_ms: firstAt ?? -1,
            statuses: rle(b),
            refusal: b.refusal,
            retry_after_ms: b.retryAfterMs,
            leaf_trace_equals_outer: sameTrace(b.outerTrace, b.leafTrace),
          },
        });
      }

      // EF14c - two traces at once, 25 calls each.
      for (let rep = 1; rep <= REPS; rep++) {
        const [x, y] = await Promise.all([fan(ctx, slug, "n=25"), fan(ctx, slug, "n=25")]);
        out.push({
          id: `EF14c${rep}`,
          title: `two concurrent traces, 25 sequential calls each, round ${rep}`,
          status: "info",
          detail: `A: ${fanLine(x)}; B: ${fanLine(y)}; A trace != B trace: ${x.outerTrace && y.outerTrace ? String(x.outerTrace !== y.outerTrace) : "?"}`,
          measurements: {
            a_ok: x.ok,
            b_ok: y.ok,
            a_first_refused: x.firstRefused,
            b_first_refused: y.firstRefused,
            total_ok: x.ok + y.ok,
            distinct_traces: x.outerTrace && y.outerTrace ? (x.outerTrace !== y.outerTrace ? 1 : 0) : -1,
            refusal: x.firstRefused ? x.refusal : y.refusal,
          },
        });
      }

      // EF14d - 40 at once.
      for (let rep = 1; rep <= REPS; rep++) {
        const d = await fan(ctx, slug, "n=40&parallel=1");
        out.push({
          id: `EF14d${rep}`,
          title: `fan of 40 parallel calls, trace ${rep}`,
          status: "info",
          detail: `${fanLine(d)}; ${rle(d)}; refusal ${d.refusal}`,
          measurements: { outer_status: d.status, ok: d.ok, refused: d.calls.filter((c) => c.status !== 200).length, statuses: rle(d), refusal: d.refusal, retry_after_ms: d.retryAfterMs },
        });
      }

      // EF14e - chain of depth 40.
      for (let rep = 1; rep <= REPS; rep++) {
        const r = await invoke(ctx, slug, { path: "?mode=chain&depth=40", timeoutMs: 140_000 });
        let reached = -1;
        let stop = "";
        let retry = "none";
        try {
          const j = JSON.parse(r.text) as { reached?: number; stop?: string; retryAfterMs?: number | null };
          reached = Number(j.reached ?? -1);
          stop = String(j.stop ?? "");
          retry = j.retryAfterMs === null || j.retryAfterMs === undefined ? "none" : String(j.retryAfterMs);
        } catch {
          stop = `unparsed: ${(r.text || r.error || "").slice(0, 160)}`;
        }
        out.push({
          id: `EF14e${rep}`,
          title: `chain of depth 40 (one nested call per hop), trace ${rep}`,
          status: "info",
          detail: `outer ${r.status} in ${r.ms} ms; nested calls that completed: ${reached}; stopped by ${stop}`,
          measurements: { docs_per_trace: docs, outer_status: r.status, nested_calls_completed: reached, stop: stop.slice(0, 200), retry_after_ms: retry, ms: r.ms },
        });
      }

      // EF14f - window: 30 calls, pause 62 s, 6 more. Three traces in parallel.
      const fs = await Promise.all(Array.from({ length: REPS }, () => fan(ctx, slug, `n=36&pauseAfter=30&pauseMs=62000`)));
      fs.forEach((f, i) => {
        const after = f.calls.filter((c) => c.i > 30);
        const before = f.calls.filter((c) => c.i <= 30);
        out.push({
          id: `EF14f${i + 1}`,
          title: `window: 30 calls, 62 s pause, 6 more, trace ${i + 1}`,
          status: "info",
          detail: `${fanLine(f)}; before pause ${before.filter((c) => c.status === 200).length}/${before.length} ok; after ${after.filter((c) => c.status === 200).length}/${after.length} ok (call 31 at ${after[0]?.at_ms ?? "?"} ms); ${rle(f)}; refusal ${f.refusal}`,
          measurements: {
            docs_window_s: RUNTIME.nestedWindowS,
            outer_status: f.status,
            ok_before_pause: before.filter((c) => c.status === 200).length,
            ok_after_pause: after.filter((c) => c.status === 200).length,
            call31_at_ms: after[0]?.at_ms ?? -1,
            statuses: rle(f),
            refusal: f.refusal,
          },
        });
      });

      // EF14g - same client-supplied traceparent on two outer invocations.
      for (let rep = 1; rep <= REPS; rep++) {
        const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
        const tid = hex(16);
        const tp = `00-${tid}-${hex(8)}-01`;
        const g1 = await fan(ctx, slug, "n=20", { traceparent: tp });
        const g2 = await fan(ctx, slug, "n=20", { traceparent: tp });
        out.push({
          id: `EF14g${rep}`,
          title: `client-supplied traceparent shared by two outer invocations, 20 calls each, round ${rep}`,
          status: "info",
          detail: `first: ${fanLine(g1)}; second: ${fanLine(g2)}; function saw the client's trace id: ${g1.outerTrace ? String(g1.outerTrace === tid) : "no traceparent"}; leaf trace = client's: ${g1.leafTrace ? String(g1.leafTrace === tid) : "?"}`,
          measurements: {
            first_ok: g1.ok,
            second_ok: g2.ok,
            second_first_refused: g2.firstRefused,
            outer_trace_is_client: g1.outerTrace ? (g1.outerTrace === tid ? 1 : 0) : -1,
            leaf_trace_is_client: g1.leafTrace ? (g1.leafTrace === tid ? 1 : 0) : -1,
            refusal: g2.firstRefused ? g2.refusal : g1.refusal,
          },
        });
      }

      // EF14h - a chain whose hops each fan out: depth 5, 10 leaf calls per hop.
      // Six hops x 10 leaf calls + 5 hop-to-hop calls = 65 function-to-function
      // calls in one chain, at most 11 from any one invocation. A budget shared
      // along the chain refuses after 30; one per calling invocation never does.
      for (let rep = 1; rep <= REPS; rep++) {
        const r = await invoke(ctx, slug, { path: "?mode=chain&depth=5&k=10", timeoutMs: 140_000 });
        let j: { reached?: number; stop?: string; leafOk?: number; leafRefused?: number; firstLeafRefusal?: string | null } = {};
        try {
          j = JSON.parse(r.text) as typeof j;
        } catch {
          j = { stop: `unparsed: ${(r.text || r.error || "").slice(0, 160)}` };
        }
        const hops = Number(j.reached ?? -1);
        const leafOk = Number(j.leafOk ?? -1);
        const leafRefused = Number(j.leafRefused ?? -1);
        out.push({
          id: `EF14h${rep}`,
          title: `chain of depth 5 with 10 leaf calls per hop (65 nested calls in one chain), trace ${rep}`,
          status: "info",
          detail: `outer ${r.status} in ${r.ms} ms; hop-to-hop calls completed ${hops} of 5; leaf calls ok ${leafOk}, refused ${leafRefused}; nested calls completed ${hops + leafOk}; ${j.firstLeafRefusal ? `first refusal ${j.firstLeafRefusal}` : "no refusal"}; stopped by ${j.stop}`,
          measurements: {
            docs_per_trace: docs,
            outer_status: r.status,
            hop_calls_completed: hops,
            leaf_calls_ok: leafOk,
            leaf_calls_refused: leafRefused,
            nested_calls_completed: hops + leafOk,
            first_refusal: (j.firstLeafRefusal ?? "none").slice(0, 200),
            stop: String(j.stop ?? "").slice(0, 200),
          },
        });
      }
    } catch (e) {
      out.push({ id: "EF14", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({ id: "EF14z", title: "cleanup: delete pvlab-ef14-* functions", status: c.left.length ? "fail" : "pass", detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`, measurements: { deleted: c.deleted, left: c.left.length } });
    }
    return out;
  },
};
export default mod;
