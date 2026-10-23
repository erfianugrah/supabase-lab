/**
 * X07 - one project unavailable: what the merged read does, how long until it
 * errors, and what a partial result looks like.
 *
 * SIDE: the X04 pair; A is always healthy, B's leg is broken in one of these
 * ways (in this order, because the later ones change B):
 *
 *   dead_ref       B's URL replaced by a ref-shaped hostname of no project
 *   nxdomain       B's URL replaced by a hostname under .invalid (no DNS answer)
 *   hang           B's URL replaced by a path on A's Edge Function that accepts
 *                  the request and does not answer for HANG_MS (20 s). Runs 1-2
 *                  (2026-10-23) measured "blackhole" instead: an address where
 *                  nothing answered the TCP connect. That target was removed
 *                  (no address literals in this repo); see the RUNLOG.
 *   trust_revoked  B real, its third-party-auth integration for A deleted
 *                  (restored afterwards and re-confirmed)
 *   restart        B real, POST /v1/projects/{ref}/restart, sampled every second
 *                  until B has failed and then answered for 30 s straight
 *   pause          POST /v1/projects/{ref}/pause on B; sampled if the API accepts it
 *
 * Merge policies (lib/merge.ts): "all" fails the whole read on the first leg
 * failure (Promise.all), "settled" waits for both legs and returns A's rows
 * flagged partial. Per-leg timeout TIMEOUT_MS in every cell. Cells per static
 * mode: client_all, client_settled, edge_all, edge_settled, N each, interleaved.
 * `ms` is the time until the read returned (result or error); for the edge
 * cells it is the client round trip, and `inner_ms` the function's own.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { lookup } from "node:dns/promises";
import { mgmt } from "../../../harness/src/mgmt.js";
import { brief, callFn, createTpa, currentPair, deleteTpa, FN_SLUG, readAll, skipWithoutPro, sleep, summary, until, type Pair } from "../lib/fanout.js";
import { fanout, pageQuery, type FanResult, type Leg, type Policy, type Target } from "../lib/merge.js";

const N = Number(process.env.PVLAB_XF_FAIL_N || 20);
/** Comma-separated subset of modes to run (PVLAB_XF_MODES); default all. */
const MODES = (process.env.PVLAB_XF_MODES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const want = (m: string) => !MODES.length || MODES.includes(m);
const TIMEOUT_MS = 3000;
const LIMIT = 50;

interface Obs {
  ok: boolean;
  partial: boolean;
  rows: number;
  ms: number;
  inner: number;
  bLeg?: Leg;
  error?: string;
  fnStatus?: number;
}

const legKey = (l?: Leg) => (l ? `${l.status}${l.code ? ` ${l.code}` : ""}${l.status === 0 && l.err ? ` ${l.err.split(":")[0]}` : ""}` : "none");

async function sample(p: Pair, targets: Target[], where: "client" | "edge", policy: Policy): Promise<Obs> {
  const qs = pageQuery(LIMIT);
  if (where === "client") {
    const r: FanResult = await fanout(targets, p.tokA, qs, LIMIT, { policy, timeoutMs: TIMEOUT_MS });
    return { ok: r.ok, partial: r.partial, rows: r.rows.length, ms: r.ms, inner: -1, bLeg: r.legs.find((l) => l.name === "b"), error: r.error };
  }
  const r = await callFn(p.a, p.tokA, { targets, qs, limit: LIMIT, policy, timeoutMs: TIMEOUT_MS }, TIMEOUT_MS + 20_000);
  return { ok: r.ok, partial: r.partial, rows: r.rows.length, ms: r.ms, inner: r.inner_ms, bLeg: r.legs.find((l) => l.name === "b"), error: r.error ?? r.raw, fnStatus: r.status };
}

function cellResult(mode: string, cell: string, obs: Obs[]): TestResult {
  const tally: Record<string, number> = {};
  for (const o of obs) tally[legKey(o.bLeg)] = (tally[legKey(o.bLeg)] ?? 0) + 1;
  const fnTally: Record<string, number> = {};
  for (const o of obs) if (o.fnStatus !== undefined) fnTally[String(o.fnStatus)] = (fnTally[String(o.fnStatus)] ?? 0) + 1;
  const okN = obs.filter((o) => o.ok).length;
  const partialN = obs.filter((o) => o.partial).length;
  const failedN = obs.filter((o) => !o.ok && !o.partial).length;
  const rowsPartial = [...new Set(obs.filter((o) => o.partial).map((o) => o.rows))].join(",");
  const s = summary("", obs.map((o) => o.ms));
  return {
    id: `X07-${mode}-${cell}`,
    title: `${mode}, ${cell}`,
    status: "info",
    detail: `n=${obs.length}: whole ${okN}, partial ${partialN} (rows ${rowsPartial || "-"}), failed ${failedN}; time to return p50 ${s.p50_ms} ms p95 ${s.p95_ms} ms max ${s.max_ms} ms; B leg ${JSON.stringify(tally)}`,
    measurements: {
      ...s,
      ...(cell.startsWith("edge") ? summary("inner_", obs.map((o) => o.inner)) : {}),
      whole: okN,
      partial: partialN,
      failed: failedN,
      partial_rows: rowsPartial || "-",
      b_leg: JSON.stringify(tally),
      ...(Object.keys(fnTally).length ? { fn_status: JSON.stringify(fnTally) } : {}),
    },
    evidence: brief(obs.find((o) => !o.ok)?.error ?? "", 240),
  };
}

async function staticMode(p: Pair, mode: string, bTarget: Target): Promise<TestResult[]> {
  const targets: Target[] = [{ name: "a", url: p.a.url, anon: p.a.anon, table: "fan_items" }, bTarget];
  const cells: Record<string, Obs[]> = { client_all: [], client_settled: [], edge_all: [], edge_settled: [] };
  for (let i = 0; i < N; i++) {
    cells.client_all?.push(await sample(p, targets, "client", "all"));
    cells.client_settled?.push(await sample(p, targets, "client", "settled"));
    cells.edge_all?.push(await sample(p, targets, "edge", "all"));
    cells.edge_settled?.push(await sample(p, targets, "edge", "settled"));
  }
  return Object.entries(cells).map(([c, obs]) => cellResult(mode, c, obs));
}

const randRef = () => Array.from({ length: 20 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const mod: TestModule = {
  id: "X07",
  title: "Fan-out with one project unavailable: error, time to error, partial results",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "X07");
    if (skip) return skip;
    const p = currentPair();
    if (!p || !p.tpaId) return [{ id: "X07", title: this.title, status: "skip", detail: "X04 did not set up the pair and trust in this process" }];
    const out: TestResult[] = [];
    const realB: Target = { name: "b", url: p.b.url, anon: p.b.anon, table: "fan_items" };

    if (want("dead_ref")) {
      const deadHost = `${randRef()}.supabase.co`;
      const dns = await lookup(deadHost).then(
        (r) => `resolved (${r.family === 6 ? "AAAA" : "A"})`,
        (e: { code?: string }) => e.code ?? "error",
      );
      out.push({
        id: "X07-dead_ref-dns",
        title: "dead_ref: DNS answer for a ref-shaped hostname of no project",
        status: "info",
        detail: `lookup from the local client: ${dns}`,
        measurements: { dns },
      });
      out.push(...(await staticMode(p, "dead_ref", { ...realB, url: `https://${deadHost}` })));
    }
    if (want("nxdomain")) out.push(...(await staticMode(p, "nxdomain", { ...realB, url: "https://fanout-dead.invalid" })));
    if (want("hang")) out.push(...(await staticMode(p, "hang", { ...realB, url: `${p.a.url}/functions/v1/${FN_SLUG}/hang` })));
    if (!want("trust_revoked") && !want("restart") && !want("pause")) return out;

    // trust_revoked: delete the integration, wait for refusal, sample, restore.
    if (want("trust_revoked")) {
      const del = await deleteTpa(ctx, p.b.ref, p.tpaId);
      const refused = await until(() => readAll(p.b, p.tokA), (r) => r.status === 401, 120_000);
      out.push({
        id: "X07-trust_revoked-setup",
        title: "trust_revoked: integration deleted on B",
        status: del < 300 && refused.ms >= 0 ? "info" : "fail",
        detail: `DELETE HTTP ${del}; B refuses after ${refused.ms} ms`,
        measurements: { delete_status: del, refused_after_ms: refused.ms },
      });
      out.push(...(await staticMode(p, "trust_revoked", realB)));
      const re = await createTpa(ctx, p);
      p.tpaId = re.id;
      const back = await until(() => readAll(p.b, p.tokA), (r) => r.status === 200, 120_000);
      out.push({
        id: "X07-trust_revoked-restore",
        title: "trust_revoked: integration re-created, token accepted again",
        status: re.status === 201 && back.ms >= 0 ? "info" : "fail",
        detail: `create HTTP ${re.status}; accepted after ${back.ms} ms`,
        measurements: { create_status: re.status, accepted_after_ms: back.ms },
      });
    }
    if (!want("restart") && !want("pause")) return out;

    // restart: sample once per second (client settled, then edge settled).
    const targets: Target[] = [{ name: "a", url: p.a.url, anon: p.a.anon, table: "fan_items" }, realB];
    const rs = await mgmt(ctx, "POST", `/projects/${p.b.ref}/restart`);
    const t0 = Date.now();
    const ticks: { t: number; where: string; o: Obs }[] = [];
    let firstFail = -1;
    let lastFail = -1;
    while (Date.now() - t0 < 360_000) {
      for (const where of ["client", "edge"] as const) {
        const o = await sample(p, targets, where, "settled");
        const t = (Date.now() - t0) / 1000;
        ticks.push({ t, where, o });
        if (!o.ok) {
          if (firstFail < 0) firstFail = t;
          lastFail = t;
        }
      }
      if (firstFail >= 0 && (Date.now() - t0) / 1000 - lastFail > 30) break;
      await sleep(1000);
    }
    const kinds: Record<string, number> = {};
    for (const k of ticks.filter((x) => !x.o.ok)) kinds[`${k.where} ${legKey(k.o.bLeg)}`] = (kinds[`${k.where} ${legKey(k.o.bLeg)}`] ?? 0) + 1;
    const failed = ticks.filter((x) => !x.o.ok);
    out.push({
      id: "X07-restart",
      title: "restart of B: settled fan-out sampled once per second (client and edge alternating)",
      status: rs.status < 300 ? "info" : "fail",
      detail: `restart HTTP ${rs.status}; ${ticks.length} samples over ${Math.round((Date.now() - t0) / 1000)} s; B leg failed in ${failed.length} (first at ${firstFail.toFixed(1)} s, last at ${lastFail.toFixed(1)} s after the call); partial results ${ticks.filter((x) => x.o.partial).length}; whole-read failures ${ticks.filter((x) => !x.o.ok && !x.o.partial).length}; kinds ${JSON.stringify(kinds)}`,
      measurements: {
        restart_status: rs.status,
        samples: ticks.length,
        b_failed_samples: failed.length,
        first_fail_s: Math.round(firstFail * 10) / 10,
        last_fail_s: Math.round(lastFail * 10) / 10,
        partial_samples: ticks.filter((x) => x.o.partial).length,
        whole_failures: ticks.filter((x) => !x.o.ok && !x.o.partial).length,
        kinds: JSON.stringify(kinds),
        ...summary("failed_sample_", failed.map((x) => x.o.ms)),
      },
      // Timeline of the failed samples: seconds after the call, vantage, B leg.
      evidence: rs.status >= 300 ? brief(rs.text, 240) : failed.map((x) => `${x.t.toFixed(1)}s ${x.where} ${legKey(x.o.bLeg)}`).join("; "),
    });

    // pause: record what the API answers; sample if it is accepted.
    const pz = await mgmt(ctx, "POST", `/projects/${p.b.ref}/pause`);
    out.push({
      id: "X07-pause-call",
      title: "pause of B through the Management API",
      status: "info",
      detail: `HTTP ${pz.status}: ${brief(pz.text, 160)}`,
      measurements: { pause_status: pz.status },
    });
    if (pz.status < 300) {
      const tp = Date.now();
      let status = "";
      let downAt = -1;
      while (Date.now() - tp < 900_000) {
        const g = await mgmt(ctx, "GET", `/projects/${p.b.ref}`);
        status = ((g.json as { status?: string } | undefined)?.status ?? "") as string;
        const r = await readAll(p.b, p.tokA);
        if (r.status !== 200 && downAt < 0) downAt = Math.round((Date.now() - tp) / 1000);
        if (status === "INACTIVE" && downAt >= 0) break;
        await sleep(10_000);
      }
      out.push({
        id: "X07-pause-state",
        title: "pause of B: project status and Data API",
        status: "info",
        detail: `status ${status} after ${Math.round((Date.now() - tp) / 1000)} s; B's Data API first non-200 at ${downAt} s`,
        measurements: { final_status: status, data_api_down_s: downAt, waited_s: Math.round((Date.now() - tp) / 1000) },
      });
      out.push(...(await staticMode(p, "paused", realB)));
    }
    return out;
  },
};
export default mod;
