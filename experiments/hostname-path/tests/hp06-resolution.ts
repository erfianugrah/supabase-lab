/**
 * HP06 - How `<ref>.supabase.co` and a custom hostname resolve, from this
 * vantage, through different paths.
 *
 *   HP06a  the project hostname, A and AAAA, through the system resolver,
 *          1.1.1.1, 8.8.8.8, 9.9.9.9 (UDP/53) and DNS-over-HTTPS (Cloudflare,
 *          Google): rcode, answer count, TTLs, whether the address set equals
 *          1.1.1.1's, the AD flag.
 *   HP06b  the custom hostname, same paths: is it a CNAME chain, and where
 *          does the chain end?
 *   HP06c  the delegation: NS sets for the root, `co.` and `supabase.co.` from
 *          `dig +trace`, whether `supabase.co` has a DS at `.co` (DNSSEC),
 *          and whether an unused label under `supabase.co` is NXDOMAIN or
 *          answers (wildcard).
 *
 * Read-only apart from DNS queries. Vantage: wherever this runs (recorded:
 * the Cloudflare colo that answers the project hostname). The ISP and
 * eastern-US vantages of the original question are NOT measured here.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dig, doh, missingTool, run, type DnsAnswer } from "../lib/net";
import { scrub, useState } from "../lib/state";

const sum = (answers: DnsAnswer[]) => {
  const chain = answers.filter((a) => a.type === "CNAME").length;
  const addrs = answers.filter((a) => a.type === "A" || a.type === "AAAA");
  return { chain, addrs: addrs.map((a) => a.data).sort(), ttl: [...new Set(answers.map((a) => a.ttl))].sort((x, y) => x - y) };
};

async function sweep(name: string, label: string, ref: string, host: string): Promise<{ m: Record<string, string>; lines: string[] }> {
  const m: Record<string, string> = {};
  const lines: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const ref1111 = await dig("1.1.1.1", name, type);
    const base = sum(ref1111.answers).addrs.join(",");
    const paths: [string, () => Promise<{ rcode: string; answers: DnsAnswer[]; ad: boolean | null; ms: number | null }>][] = [
      ["system", async () => { const r = await dig(undefined, name, type); return { rcode: r.rcode, answers: r.answers, ad: r.flags.includes("ad"), ms: r.queryMs }; }],
      ["1.1.1.1", async () => ({ rcode: ref1111.rcode, answers: ref1111.answers, ad: ref1111.flags.includes("ad"), ms: ref1111.queryMs })],
      ["8.8.8.8", async () => { const r = await dig("8.8.8.8", name, type); return { rcode: r.rcode, answers: r.answers, ad: r.flags.includes("ad"), ms: r.queryMs }; }],
      ["9.9.9.9", async () => { const r = await dig("9.9.9.9", name, type); return { rcode: r.rcode, answers: r.answers, ad: r.flags.includes("ad"), ms: r.queryMs }; }],
      ["doh-cloudflare", async () => { const r = await doh("cloudflare", name, type); return { rcode: r.rcode === 0 ? "NOERROR" : `rcode ${r.rcode ?? r.error}`, answers: r.answers, ad: r.ad, ms: null }; }],
      ["doh-google", async () => { const r = await doh("google", name, type); return { rcode: r.rcode === 0 ? "NOERROR" : `rcode ${r.rcode ?? r.error}`, answers: r.answers, ad: r.ad, ms: null }; }],
    ];
    for (const [p, f] of paths) {
      const r = await f();
      const s = sum(r.answers);
      const same = s.addrs.join(",") === base ? "same-set-as-1.1.1.1" : "different-set";
      m[`${label}_${type}_${p}`] = `${r.rcode}; ${s.chain} CNAME, ${s.addrs.length} addr; ttl ${s.ttl.join("/") || "-"}; ${same}; ad=${r.ad}${r.ms !== null ? `; ${r.ms} ms` : ""}`;
      lines.push(`${label} ${type} ${p}: ${scrub(JSON.stringify(r.answers.map((a) => `${a.type} ${a.data}`)), ref, host)}`);
    }
  }
  return { m, lines };
}

const mod: TestModule = {
  id: "HP06",
  title: "Resolution of the project and custom hostnames through five resolvers and DoH",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st) return [{ id: "HP06", title: this.title, status: "skip", detail: "no .state.json (HP01 did not run)" }];
    const missing = missingTool("dig", "curl");
    if (missing) return [{ id: "HP06", title: this.title, status: "skip", detail: `${missing} not available` }];
    const out: TestResult[] = [];

    const a = await sweep(`${st.ref}.supabase.co`, "origin", st.ref, st.host);
    const nSys = a.m["origin_A_system"] ?? "";
    out.push({
      id: "HP06a",
      title: "project hostname, A and AAAA, six paths",
      status: Object.values(a.m).every((v) => v.startsWith("NOERROR")) ? "pass" : "fail",
      detail: `system resolver: ${nSys}; 1.1.1.1: ${a.m["origin_A_1.1.1.1"]}`,
      measurements: a.m,
      evidence: a.lines.join("\n"),
    });

    if (st.domainActive) {
      const b = await sweep(st.host, "custom", st.ref, st.host);
      out.push({
        id: "HP06b",
        title: "custom hostname, A and AAAA, six paths",
        status: Object.values(b.m).every((v) => v.startsWith("NOERROR")) ? "pass" : "fail",
        detail: `system resolver: ${b.m["custom_A_system"]}; 1.1.1.1: ${b.m["custom_A_1.1.1.1"]}`,
        measurements: b.m,
        evidence: b.lines.join("\n"),
      });
    }

    // ---- c: delegation ----
    const trace = await run(["dig", "+trace", "+nodnssec", "+time=5", "+tries=2", `${st.ref}.supabase.co`, "A"], 60_000);
    const zones = new Map<string, Set<string>>();
    for (const l of trace.out.split("\n")) {
      const m = /^(\S*)\s+\d+\s+IN\s+NS\s+(\S+)/.exec(l);
      if (m) {
        const z = m[1] || ".";
        zones.set(z, (zones.get(z) ?? new Set()).add(m[2]!));
      }
    }
    const final = /Received \d+ bytes from (\S+)#53\(([^)]+)\)/g;
    const servers = [...trace.out.matchAll(final)].map((x) => x[2]!);
    const ds = await dig("1.1.1.1", "supabase.co", "DS", ["+dnssec"]);
    const dnskey = await dig("1.1.1.1", "supabase.co", "DNSKEY", ["+dnssec"]);
    const ns = await dig("1.1.1.1", "supabase.co", "NS");
    const unused = await dig("1.1.1.1", `hp-unused-${Math.floor(Math.random() * 1e6)}.supabase.co`, "A");
    const tld = await dig("1.1.1.1", "co", "NS");
    out.push({
      id: "HP06c",
      title: "delegation chain, DNSSEC and wildcard behaviour of supabase.co",
      status: "info",
      detail: `trace zones ${[...zones.entries()].map(([z, s]) => `${z}=${s.size}NS`).join(" ")}; last server answering ${servers[servers.length - 1] ?? "?"}; supabase.co NS ${ns.answers.length}; DS at .co ${ds.answers.filter((x) => x.type === "DS").length}; DNSKEY ${dnskey.answers.filter((x) => x.type === "DNSKEY").length}; unused label ${unused.rcode} (${unused.answers.length} answer(s))`,
      measurements: {
        trace_zones: [...zones.entries()].map(([z, s]) => `${z}:${s.size}`).join(" "),
        authoritative_ns_for_supabase_co: ns.answers.map((x) => x.data.replace(/\.$/, "")).sort().join(" "),
        co_tld_ns_count: tld.answers.length,
        ds_records_for_supabase_co: ds.answers.filter((x) => x.type === "DS").length,
        dnskey_records_for_supabase_co: dnskey.answers.filter((x) => x.type === "DNSKEY").length,
        unused_label_rcode: unused.rcode,
        unused_label_answers: unused.answers.map((x) => x.type).join("+") || "none",
      },
      evidence: scrub(trace.out, st.ref, st.host).slice(0, 6000),
    });
    return out;
  },
};
export default mod;
