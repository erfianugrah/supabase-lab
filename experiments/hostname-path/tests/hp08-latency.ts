/**
 * HP08 - Phase-split latency (DNS, TCP, TLS, TTFB) to the project hostname and
 * to the custom hostname, from THIS vantage only.
 *
 * `GET /auth/v1/health` with the anon key, a fresh curl process per sample (new
 * connection, new TLS handshake), the two hosts interleaved so a drift hits
 * both. DNS is curl's `time_namelookup` through the system resolver, so it is
 * mostly the resolver's cache; a separate row times `dig @1.1.1.1` for both
 * names. n = SAMPLES per host, one run.
 *
 * The question's eastern-US :00/:30 vantage is NOT measured here: it needs a
 * host in that region, and the AWS credentials in the vault were rejected
 * (`InvalidClientTokenId`, an unrecorded observation) on 2026-10-10. The module is vantage-agnostic -
 * run it from a host there (`make run ONLY=HP08` with the state file copied,
 * or the same curl loop by hand) and compare the `colo` column.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { curlPhases, dig, missingTool, pct, type Phases } from "../lib/net";
import { useState } from "../lib/state";

const SAMPLES = Number(process.env.HP_SAMPLES ?? 40);

const mod: TestModule = {
  id: "HP08",
  title: "Phase-split latency, project hostname vs custom hostname",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st?.domainActive) return [{ id: "HP08", title: this.title, status: "skip", detail: "custom domain not active (HP03 did not complete)" }];
    const missing = missingTool("dig", "curl");
    if (missing) return [{ id: "HP08", title: this.title, status: "skip", detail: `${missing} not available` }];
    const targets: [string, string][] = [["origin", `${st.ref}.supabase.co`], ["custom", st.host]];
    const rows: Record<string, Phases[]> = { origin: [], custom: [] };
    const started = new Date().toISOString();
    for (let i = 0; i < SAMPLES; i++) {
      for (const [label, h] of targets) rows[label]!.push(await curlPhases(`https://${h}/auth/v1/health`, { apikey: st.anon }));
      await Bun.sleep(1_000);
    }
    const m: Record<string, string | number> = { samples_per_host: SAMPLES, started_utc: started.slice(0, 16) };
    const detail: string[] = [];
    for (const [label] of targets) {
      const ok = rows[label]!.filter((p) => p.code === 200);
      m[`${label}_ok`] = `${ok.length}/${rows[label]!.length}`;
      for (const k of ["dnsMs", "tcpMs", "tlsMs", "ttfbMs", "totalMs"] as const) {
        const xs = ok.map((p) => p[k]);
        m[`${label}_${k.replace("Ms", "")}_p50_ms`] = Math.round(pct(xs, 0.5));
        m[`${label}_${k.replace("Ms", "")}_p95_ms`] = Math.round(pct(xs, 0.95));
      }
      m[`${label}_colo`] = [...new Set(ok.map((p) => p.colo))].join("+") || "-";
      m[`${label}_remote_ips`] = new Set(ok.map((p) => p.ip)).size;
      detail.push(`${label}: ${ok.length}/${rows[label]!.length} ok, total p50 ${m[`${label}_total_p50_ms`]} ms (dns ${m[`${label}_dns_p50_ms`]}, tcp ${m[`${label}_tcp_p50_ms`]}, tls ${m[`${label}_tls_p50_ms`]}, ttfb ${m[`${label}_ttfb_p50_ms`]}), colo ${m[`${label}_colo`]}`);
    }
    // Resolver time to a public recursor, 10 queries each.
    for (const [label, h] of targets) {
      const ms: number[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await dig("1.1.1.1", h, "A", ["+noedns"]);
        if (r.queryMs !== null) ms.push(r.queryMs);
        await Bun.sleep(500);
      }
      m[`${label}_dig_1.1.1.1_min_ms`] = Math.min(...ms);
      m[`${label}_dig_1.1.1.1_p50_ms`] = pct(ms, 0.5);
      m[`${label}_dig_1.1.1.1_max_ms`] = Math.max(...ms);
    }
    return [
      {
        id: "HP08a",
        title: "per-phase latency, interleaved, fresh connection per sample",
        status: "info",
        detail: detail.join("; "),
        measurements: m,
        evidence: JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.map((p) => [p.code, Math.round(p.dnsMs), Math.round(p.tcpMs), Math.round(p.tlsMs), Math.round(p.ttfbMs)])]))),
      },
    ];
  },
};
export default mod;
