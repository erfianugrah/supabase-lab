/**
 * MS02 - switching the IPv4 add-on on: how long until an IPv4-only client can
 * reach the dedicated pooler, and what else moves while DNS changes.
 *
 * The docs say the add-on is not dual-stack (the AAAA record is swapped for an
 * A record) and that direct connections "may see under a minute" of downtime
 * while DNS propagates. Nothing in this repo had ever enabled it. Rows, all
 * sampled every 500 ms from this IPv4-only vantage:
 *
 *   MS02a  the operation: PATCH billing/addons {ipv4, ipv4_default} - status
 *          and latency of the API call itself.
 *   MS02b  DNS: seconds until an A record appears for db.<ref>.supabase.co
 *          and until the AAAA record is gone (resolver-visible, this vantage).
 *   MS02c  first successful connect on direct 5432 and dedicated 6543 (both
 *          unreachable before, per MS01d) - the time-to-usable a Vercel
 *          function would see.
 *   MS02d  control paths across the same window: shared pooler 6543, REST
 *          and Realtime - failures during the switch, if any. Since
 *          2026-10-23 (#208) REST and Realtime are each probed twice: the
 *          HTTP-tier `rest_http` (anon `GET /rest/v1/`, answered 401 by the
 *          API gateway before PostgREST or the database is reached; the only
 *          REST probe of the 2026-09-30 run) and `realtime_ws` (handshake),
 *          and the data-path `rest_read` and `realtime_join`
 *          (harness/src/real-probes.ts).
 *
 * DESTRUCTIVE and BILLABLE: leaves the add-on ON (USD 0.0055/h) because every
 * later module needs 6543 and 5432 reachable from here; `make destroy`
 * removes it with the project. Not settled: the propagation seen by OTHER
 * resolvers, and the downtime a client that was already connected over IPv6
 * would see - this vantage has no IPv6.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { realtimeJoinProbe, restReadProbe, seedProbeTable } from "../../../harness/src/real-probes";
import { withDeadline } from "../../../harness/src/sampler";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addons, dedicatedTarget, directTarget, dnsRecords, errText, pgOnce, primaryPooler, realtimeProbe, restProbe, sharedTargets, sleep } from "../lib/setup";

const INTERVAL_MS = 500;
const MAX_WAIT_MS = 10 * 60_000;
const SETTLE_MS = 10_000;

const mod: TestModule = {
  id: "MS02",
  title: "IPv4 add-on switch: DNS swap, time-to-usable for direct 5432 and dedicated 6543",
  where: "local",
  requires: ["pat", "db", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ad = await addons(ctx);
    if (ad.selected.some((a) => a.type === "ipv4"))
      return [{ id: "MS02", title: mod.title, status: "skip", detail: "ipv4 add-on already selected - nothing to switch" }];
    if (!ad.available.includes("ipv4"))
      return [{ id: "MS02", title: mod.title, status: "skip", detail: `ipv4 not in available_addons [${ad.available.join(",")}]` }];

    const sv = await primaryPooler(ctx);
    const shared = sv ? sharedTargets(sv).txn : null;
    const direct = directTarget(ctx);
    const ded = dedicatedTarget(ctx);
    // HTTP-tier probes first, data-path probes after them when the seed passes.
    const http = [restProbe(ctx), realtimeProbe(ctx)];
    let dataNote = "";
    try {
      const secs = await seedProbeTable(ctx, ctx.apiHost, ctx.anonKey ?? "");
      http.push(restReadProbe(ctx.apiHost, ctx.anonKey ?? ""), realtimeJoinProbe(ctx.apiHost, ctx.anonKey ?? ""));
      dataNote = `data-path probes ready after ${secs}s`;
    } catch (e) {
      dataNote = `data-path probes skipped: ${errText(e)}`;
    }
    ctx.log(`MS02 control probes: ${http.map((p) => p.name).join(", ")} (${dataNote})`);
    const ctlFails = new Map<string, number>(http.map((p) => [p.name, 0]));
    const ctlSamples = new Map<string, number>(http.map((p) => [p.name, 0]));

    const t0 = Date.now();
    const rel = () => Date.now() - t0;
    let tA: number | null = null;
    let tNoAAAA: number | null = null;
    let tDirect: number | null = null;
    let tDed: number | null = null;
    let directSustainedFrom: number | null = null;
    let dedSustainedFrom: number | null = null;
    let sharedFails = 0;
    let samples = 0;
    const modes = new Map<string, string>();
    let stop = false;

    const loop = (async () => {
      while (!stop) {
        samples++;
        const [dns, d, dd, s] = await Promise.all([
          dnsRecords(ctx.phzHost),
          pgOnce(direct, ctx.dbPassword),
          pgOnce(ded, ctx.dbPassword),
          shared ? pgOnce(shared, ctx.dbPassword) : Promise.resolve<{ ok: boolean; error?: string; ms: number }>({ ok: true, ms: 0 }),
        ]);
        const now = rel();
        if (tA === null && dns.a.length) tA = now;
        // Tracked independently of the A record: the first run (2026-09-30)
        // saw the AAAA withdrawn long before any A appeared, i.e. a window
        // with NO record - which this line previously could not record.
        if (tNoAAAA === null && samples > 2 && dns.aaaa.length === 0) tNoAAAA = now;
        if (d.ok) {
          if (tDirect === null) tDirect = now;
          if (directSustainedFrom === null) directSustainedFrom = now;
        } else {
          directSustainedFrom = null;
          if (d.error) modes.set("direct", d.error);
        }
        if (dd.ok) {
          if (tDed === null) tDed = now;
          if (dedSustainedFrom === null) dedSustainedFrom = now;
        } else {
          dedSustainedFrom = null;
          if (dd.error) modes.set("dedicated", dd.error);
        }
        if (!s.ok) {
          sharedFails++;
          if (s.error) modes.set("shared", s.error);
        }
        if (
          directSustainedFrom !== null &&
          dedSustainedFrom !== null &&
          now - directSustainedFrom >= SETTLE_MS &&
          now - dedSustainedFrom >= SETTLE_MS
        )
          break;
        if (now > MAX_WAIT_MS) break;
        await sleep(INTERVAL_MS);
      }
    })();

    // Control paths on their own loops, one per probe, so a slow Realtime join
    // (up to 10 s when failing) does not pace the DNS and Postgres samples.
    let mainDone = false;
    const ctlLoops = http.map(async (p) => {
      while (!mainDone && !stop) {
        const o = await withDeadline(p.run());
        ctlSamples.set(p.name, (ctlSamples.get(p.name) ?? 0) + 1);
        if (!o.ok) {
          ctlFails.set(p.name, (ctlFails.get(p.name) ?? 0) + 1);
          if (o.error) modes.set(p.name, o.error);
        }
        await sleep(INTERVAL_MS);
      }
    });

    // Two baseline samples, then fire.
    await sleep(2 * INTERVAL_MS);
    const tCall = rel();
    const r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/billing/addons`, { addon_type: "ipv4", addon_variant: "ipv4_default" });
    const callMs = rel() - tCall;
    ctx.log(`ipv4 add-on PATCH: HTTP ${r.status} in ${callMs}ms`);
    if (r.status >= 300) stop = true;
    await loop;
    const tEnd = rel();
    mainDone = true;
    await Promise.all(ctlLoops);

    const after = await dnsRecords(ctx.phzHost);
    const s = (ms: number | null) => (ms === null ? "n/a" : Math.round(ms / 100) / 10);
    const out: TestResult[] = [
      {
        id: "MS02a",
        title: "PATCH billing/addons ipv4_default",
        status: r.status < 300 ? "pass" : "fail",
        detail: `HTTP ${r.status} in ${callMs}ms${r.status >= 300 ? `: ${r.text.slice(0, 200)}` : ""}`,
        measurements: { http_status: r.status, call_ms: callMs },
      },
    ];
    if (r.status >= 300) return out;
    out.push(
      {
        id: "MS02b",
        title: "DNS swap for the database host, seen from this resolver",
        status: tA !== null ? "pass" : "fail",
        // The loop also ends once both Postgres paths have connected for SETTLE_MS,
        // so "no A record" holds for the sampled span, not for MAX_WAIT_MS
        // (2026-10-23: getaddrinfo reached the host at 79 s while resolve4
        // still had no A when sampling ended SETTLE_MS, 10 s, later).
        detail:
          tA === null
            ? `resolve4 saw no A record before sampling ended at ${s(tEnd)}s (cap ${Math.round(MAX_WAIT_MS / 1000)}s); AAAA gone at ${s(tNoAAAA)}s`
            : `A record at ${s(tA)}s after sampling started; AAAA gone at ${s(tNoAAAA)}s; now A=${after.a.length} AAAA=${after.aaaa.length}`,
        measurements: { a_record_s: s(tA), aaaa_gone_s: s(tNoAAAA), a_after: after.a.length, aaaa_after: after.aaaa.length, patch_at_s: s(tCall), sampling_ended_s: s(tEnd) },
      },
      {
        id: "MS02c",
        title: "time-to-usable from IPv4: direct 5432 and dedicated 6543",
        status: tDirect !== null && tDed !== null ? "pass" : "fail",
        detail: `direct first ok ${s(tDirect)}s, dedicated first ok ${s(tDed)}s (sampling started ${s(tCall)}s before the PATCH returned); ${samples} samples at ${INTERVAL_MS}ms`,
        measurements: { direct_first_ok_s: s(tDirect), dedicated_first_ok_s: s(tDed), samples, direct_last_error: modes.get("direct") ?? "", dedicated_last_error: modes.get("dedicated") ?? "" },
      },
      {
        id: "MS02d",
        title: "control paths across the switch: shared pooler 6543, REST and Realtime",
        status: sharedFails === 0 && [...ctlFails.values()].every((n) => n === 0) ? "pass" : "info",
        detail:
          `shared pooler failed ${sharedFails}/${samples} samples, ` +
          [...ctlFails].map(([n, f]) => `${n} failed ${f}/${ctlSamples.get(n) ?? 0}`).join(", ") +
          `; ${dataNote}`,
        measurements: {
          shared_fail_samples: sharedFails,
          shared_mode: modes.get("shared") ?? "none",
          ...Object.fromEntries(
            [...ctlFails].flatMap(([n, f]) => [
              [`${n}_fail_samples`, f],
              [`${n}_samples`, ctlSamples.get(n) ?? 0],
              [`${n}_mode`, modes.get(n) ?? "none"],
            ]),
          ),
        },
      },
    );
    return out;
  },
};
export default mod;
