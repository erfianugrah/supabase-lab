/**
 * T13 - the Data API stays public, and its root behaves unintuitively.
 *
 * Two things worth recording: PostgREST's root path rejects the anon key and
 * asks for service_role (which reads as key misconfiguration when it is not),
 * and the API hostname resolves publicly even from inside the VPC - the
 * endpoint carries the database socket only.
 */
import { $ } from "bun";
import type { TestModule, TestResult } from "../../../harness/src/types";

async function timed(url: string, headers: Record<string, string>) {
  const t0 = performance.now();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t0), body };
}

const mod: TestModule = {
  id: "T13",
  title: "Data API reachability and DNS split",
  where: "runner",
  requires: ["anon-key"],
  async run(ctx) {
    const results: TestResult[] = [];
    const key = ctx.anonKey!;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };

    const root = await timed(`https://${ctx.apiHost}/rest/v1/`, headers);
    const serviceRoleOnly = /service_role/i.test(root.body);
    results.push({
      id: "T13a",
      title: "PostgREST root with the anon key",
      status: "info",
      detail: serviceRoleOnly
        ? "root rejects the anon key and demands service_role - probe a real table instead"
        : `root answered ${root.status}`,
      measurements: { status: root.status, ms: root.ms },
      evidence: root.body.slice(0, 200),
    });

    // Warm serial samples for a latency floor over the public path.
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await timed(`https://${ctx.apiHost}/rest/v1/`, headers);
      samples.push(r.ms);
    }
    samples.sort((a, b) => a - b);
    results.push({
      id: "T13b",
      title: "Data API latency from in-VPC (via NAT, public path)",
      status: "info",
      detail: "the endpoint does not carry HTTP services",
      measurements: {
        min_ms: samples[0] ?? 0,
        p50_ms: samples[Math.floor(samples.length / 2)] ?? 0,
        p95_ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
      },
    });

    const apiIp = (await $`dig +short ${ctx.apiHost}`.quiet().nothrow().text())
      .split("\n")
      .find((l) => /^[0-9.]+$/.test(l.trim()));
    const dbIp = (await $`dig +short ${ctx.phzHost}`.quiet().nothrow().text())
      .split("\n")
      .find((l) => /^[0-9.]+$/.test(l.trim()));
    const dbIsPrivate = /^10\./.test(dbIp ?? "");
    results.push({
      id: "T13c",
      title: "DNS split between API and database hostnames",
      status: dbIsPrivate ? "pass" : "fail",
      detail: dbIsPrivate
        ? `database resolves inside the VPC (${dbIp}) while the API resolves publicly (${apiIp})`
        : `database hostname did not resolve to a private address (${dbIp})`,
      measurements: { api_ip: apiIp ?? "none", db_ip: dbIp ?? "none" },
    });

    return results;
  },
};
export default mod;
