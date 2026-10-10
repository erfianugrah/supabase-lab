/**
 * HP07 - Simulate `supabase.co` answering NXDOMAIN at a resolver, and see
 * whether an app configured with the custom hostname keeps working.
 *
 * The rig (lib/resolver.ts): a recursive Unbound in Docker, the app in a second
 * container whose only resolver is that Unbound, and an Unbound zone forward
 * that sends `supabase.co.` to a dnsmasq which answers NXDOMAIN for it. The
 * forward applies to CNAME targets, so a name whose chain passes through
 * `supabase.co` fails the way it would behind a resolver that sees the zone as
 * non-existent. What this does NOT simulate: an outage on the authoritative
 * side that other resolvers see differently, or a TLD-level failure that also
 * hits other zones under `.co`. The custom hostname lives under a different
 * TLD, so a `.co` failure is not exercised either way.
 *
 *   HP07a  before anything is broken: does the custom hostname answer over the
 *          project hostname's own addresses (curl pinned to each address)?
 *          That is what a DNS record without `supabase.co` in its chain needs.
 *   HP07b  control: app on the custom host and on the project host, recursion intact.
 *   HP07c  supabase.co NXDOMAIN, custom hostname still a CNAME to the project host.
 *   HP07d  supabase.co NXDOMAIN, custom hostname's CNAME replaced by A/AAAA
 *          records holding the addresses the project hostname resolves to.
 *   HP07e  cache: answers resolved before the outage, outage switched on without
 *          flushing; how long the cached chain keeps answering.
 *
 * The custom hostname's DNS is restored to the CNAME in `finally`.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addRecord, cfAvailable, removeRecords, zoneId } from "../lib/cfdns";
import { dig, dockerUp, missingTool, run } from "../lib/net";
import { PW, USER_EMAIL, scrub, useState } from "../lib/state";
import { digIn, down, flush, nxdomain, runApp, up } from "../lib/resolver";

const APP = `${import.meta.dir}/../lib/app.ts`;
const NODE_MODULES = `${import.meta.dir}/../../../node_modules`;

const mod: TestModule = {
  id: "HP07",
  title: "supabase.co NXDOMAIN at the resolver: project host vs custom host (CNAME and A/AAAA)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st?.domainActive) return [{ id: "HP07", title: this.title, status: "skip", detail: "custom domain not active (HP03 did not complete)" }];
    if (!cfAvailable()) return [{ id: "HP07", title: this.title, status: "skip", detail: "no Cloudflare credentials" }];
    const missing = missingTool("dig", "curl");
    if (missing) return [{ id: "HP07", title: this.title, status: "skip", detail: `${missing} not available` }];
    if (!(await dockerUp())) return [{ id: "HP07", title: this.title, status: "skip", detail: "docker not available (binary missing or daemon not running)" }];
    const origin = `${st.ref}.supabase.co`;
    const host = st.host;
    const out: TestResult[] = [];
    const zone = await zoneId(host);
    const lbl = (s: string) => scrub(s, st.ref, host);

    // ---- a: addresses and direct-IP serving ----
    const ips = new Set<string>();
    for (const t of ["A", "AAAA"]) for (const a of (await dig("1.1.1.1", origin, t)).answers) if (a.type === t) ips.add(a.data);
    const direct: Record<string, string> = {};
    for (const ip of ips) {
      const v6 = ip.includes(":");
      for (const [who, h] of [["custom", host], ["origin", origin]] as const) {
        const r = await run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", "--resolve", `${h}:443:${ip}`, `https://${h}/functions/v1/hp-mock-idp/ping`]);
        direct[`${who}_via_${v6 ? "v6" : "v4"}_${[...ips].filter((x) => x.includes(":") === v6).indexOf(ip) + 1}`] = r.out.trim() || `curl exit ${r.code}${r.err ? ` (${r.err.trim().slice(0, 60)})` : ""}`;
      }
    }
    out.push({
      id: "HP07a",
      title: "custom hostname over the project hostname's own addresses, curl pinned (SNI = custom host)",
      status: Object.entries(direct).filter(([k]) => k.startsWith("custom")).every(([, v]) => v === "200") ? "pass" : "fail",
      detail: `${ips.size} address(es) from 1.1.1.1 for the project hostname; ${JSON.stringify(direct)}`,
      measurements: direct,
    });

    const appEnv = (url: string) => ({ APP_URL: url, ANON: st.anon, EMAIL: USER_EMAIL, PW });
    const appRow = async (label: string, url: string, dnsIp: string): Promise<Record<string, string>> => {
      const r = await runApp(appEnv(url), dnsIp, APP, NODE_MODULES);
      const m: Record<string, string> = {};
      for (const l of r.lines as { op: string; ok: boolean; result: string }[]) m[`${label}_${l.op.replace(/-/g, "_")}`] = l.op === "hosts-requested" ? lbl(l.result).replace(origin, "origin") : l.ok ? `ok: ${l.result}` : `FAIL: ${lbl(l.result)}`;
      if (!r.lines.length) m[`${label}_container`] = `no output; exit ${r.code}; ${lbl(r.err)}`;
      return m;
    };
    const resolveRow = async (label: string, names: [string, string][]) => {
      const m: Record<string, string> = {};
      for (const [n, key] of names) {
        const a = await digIn(n, "A");
        m[`${label}_dns_${key}`] = `${a.rcode}; ${a.answers.filter((x) => x.type === "CNAME").length} CNAME, ${a.answers.filter((x) => x.type === "A").length} A; ttl ${[...new Set(a.answers.map((x) => x.ttl))].join("/") || "-"}`;
      }
      return m;
    };
    const okCount = (m: Record<string, string>, label: string) => Object.entries(m).filter(([k]) => k.startsWith(`${label}_`) && !k.includes("_dns_") && !k.endsWith("hosts_requested")).filter(([, v]) => v.startsWith("ok")).length;
    const opCount = (m: Record<string, string>, label: string) => Object.entries(m).filter(([k]) => k.startsWith(`${label}_`) && !k.includes("_dns_") && !k.endsWith("hosts_requested")).length;

    try {
      const rig = await up();

      // ---- b: control ----
      const b: Record<string, string> = {
        ...(await resolveRow("ctl", [[origin, "origin"], [host, "custom"]])),
        ...(await appRow("ctl_custom", `https://${host}`, rig.unbound)),
        ...(await appRow("ctl_origin", `https://${origin}`, rig.unbound)),
      };
      out.push({
        id: "HP07b",
        title: "control: recursion intact, app on the custom host and on the project host",
        status: okCount(b, "ctl_custom") === opCount(b, "ctl_custom") && okCount(b, "ctl_origin") === opCount(b, "ctl_origin") ? "pass" : "fail",
        detail: `custom ${okCount(b, "ctl_custom")}/${opCount(b, "ctl_custom")} ops ok; project host ${okCount(b, "ctl_origin")}/${opCount(b, "ctl_origin")} ops ok`,
        measurements: b,
      });

      // ---- c: NXDOMAIN, custom host a CNAME ----
      const sw = await nxdomain(true, rig.nx);
      await flush(host, origin);
      const c: Record<string, string> = {
        switch: sw,
        ...(await resolveRow("nx_cname", [[origin, "origin"], [host, "custom"]])),
        ...(await appRow("nx_cname_custom", `https://${host}`, rig.unbound)),
        ...(await appRow("nx_cname_origin", `https://${origin}`, rig.unbound)),
      };
      out.push({
        id: "HP07c",
        title: "supabase.co NXDOMAIN; custom host is a CNAME to the project host",
        status: "info",
        detail: `dns custom: ${c["nx_cname_dns_custom"]}; dns project host: ${c["nx_cname_dns_origin"]}; app on custom ${okCount(c, "nx_cname_custom")}/${opCount(c, "nx_cname_custom")} ops ok; app on project host ${okCount(c, "nx_cname_origin")}/${opCount(c, "nx_cname_origin")} ops ok`,
        measurements: c,
      });

      // ---- d: NXDOMAIN, custom host flattened to A/AAAA ----
      await removeRecords(zone, [host], ["CNAME"]);
      const wrote: string[] = [];
      for (const ip of ips) wrote.push(`${ip.includes(":") ? "AAAA" : "A"} ${(await addRecord(zone, ip.includes(":") ? "AAAA" : "A", host, ip)).status}`);
      await flush(host);
      await Bun.sleep(2_000);
      const hostStatusFlat = (((await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`)).json ?? {}) as { status?: string }).status ?? "?";
      const d: Record<string, string> = {
        dns_writes: wrote.join(", "),
        hostname_status_after_flatten: hostStatusFlat,
        ...(await resolveRow("nx_flat", [[origin, "origin"], [host, "custom"]])),
        ...(await appRow("nx_flat_custom", `https://${host}`, rig.unbound)),
      };
      out.push({
        id: "HP07d",
        title: "supabase.co NXDOMAIN; custom host flattened to A/AAAA records",
        status: "info",
        detail: `dns custom: ${d["nx_flat_dns_custom"]}; app on custom ${okCount(d, "nx_flat_custom")}/${opCount(d, "nx_flat_custom")} ops ok; platform status after the CNAME was removed: ${hostStatusFlat}`,
        measurements: d,
      });

      // ---- e: warm cache, then the outage without a flush ----
      await removeRecords(zone, [host], ["A", "AAAA"]);
      await addRecord(zone, "CNAME", host, origin);
      await nxdomain(false, rig.nx);
      await flush(host, origin);
      await Bun.sleep(2_000);
      const warm = await digIn(host, "A");
      const t0 = Date.now();
      await nxdomain(true, rig.nx); // NOT flushed
      const e: Record<string, string> = { warm_before: `${warm.rcode}; ${warm.answers.length} records; ttl ${[...new Set(warm.answers.map((x) => x.ttl))].join("/")}` };
      const samples: string[] = [];
      let firstFail = "never within 400s";
      for (let i = 0; i < 14; i++) {
        const q = await digIn(host, "A");
        const t = Math.round((Date.now() - t0) / 1000);
        samples.push(`${t}s:${q.rcode}`);
        if (q.rcode !== "NOERROR" && firstFail.startsWith("never")) {
          firstFail = `${t}s (${q.rcode})`;
          break;
        }
        await Bun.sleep(30_000);
      }
      e.samples = samples.join(" ");
      e.first_failure = firstFail;
      out.push({
        id: "HP07e",
        title: "cache: chain resolved before the outage, outage switched on without a flush",
        status: "info",
        detail: `before: ${e["warm_before"]}; samples ${samples.join(" ")}; first failure ${firstFail}`,
        measurements: e,
      });
    } finally {
      // Leave the custom hostname's DNS as the platform asked for it.
      await removeRecords(zone, [host], ["A", "AAAA"]).catch(() => 0);
      await addRecord(zone, "CNAME", host, origin).catch(() => undefined);
      await down().catch(() => undefined);
    }
    return out;
  },
};
export default mod;
