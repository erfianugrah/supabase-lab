/**
 * TL17 - the whole HTTP-edge battery (TL01-TL05) against a custom domain.
 *
 * A custom domain is measured as its own surface rather than assumed
 * identical to `<ref>.supabase.co`: the certificate is issued for the
 * customer's name by a different flow, and the edge config attached to that
 * hostname may differ.
 *
 * Brings the hostname up (lib/custom-domain.ts), waits until it serves,
 * runs protocols / suites / certificates / SNI-ALPN-HSTS / CBC-only client
 * pinned to 1.1.1.1's answer, and tears everything down in `finally`.
 * Needs `~/bin/knotctl` with the lab zone write key. DESTRUCTIVE and
 * BILLABLE (the custom domain add-on bills while on). Host from
 * PVLAB_ENDPOINT_CUSTOM_HOST, default tl17.lab.erfi.io.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { hasKnotctl, setupCustomDomain, teardownCustomDomain } from "../lib/custom-domain";
import type { Target } from "../lib/tls";
import { protocolRows } from "./tl01-edge-protocols";
import { cipherRows } from "./tl02-edge-ciphers";
import { certRows } from "./tl03-edge-certs";
import { edgeExtrasRows } from "./tl04-edge-sni-alpn";
import { cbcClientRows } from "./tl05-cbc-client";

const mod: TestModule = {
  id: "TL17",
  title: "Custom domain: TL01-TL05 battery on the customer hostname",
  where: "local",
  requires: ["pat", "anon-key", "openssl"],
  destructive: true,
  async run(ctx) {
    const host = ctx.endpoints.custom_host ?? "tl17.lab.erfi.io";
    const anon = ctx.anonKey ?? "";
    const out: TestResult[] = [];
    if (!hasKnotctl()) return [{ id: "TL17", title: mod.title, status: "skip", detail: "~/bin/knotctl not found - DNS for the hostname cannot be written, so nothing billable was started" }];
    const s = await setupCustomDomain(ctx, host, anon);
    try {
      out.push({ id: "TL17-setup", title: `custom hostname ${host} brought up`, status: s.ready ? "pass" : "fail", detail: s.steps.join(", "), measurements: { ready: s.ready ? "yes" : "no", edge_ip: s.ip } });
      if (!s.ready) return out;
      const t: Target = { role: "custom_domain", host, port: 443, connect: s.ip };
      out.push(...(await protocolRows("TL17-proto", [t])));
      out.push(...(await cipherRows("TL17-ciphers", [t])));
      out.push(...(await certRows("TL17-cert", [t])));
      out.push(...(await edgeExtrasRows("TL17-extras", [t], anon)));
      out.push(...(await cbcClientRows("TL17-cbc", host, ctx.ref, anon, { host, ip: s.ip })));
    } finally {
      out.push({ id: "TL17-teardown", title: "custom hostname, DNS and add-on removed", status: "info", detail: await teardownCustomDomain(ctx, s) });
    }
    return out;
  },
};
export default mod;
