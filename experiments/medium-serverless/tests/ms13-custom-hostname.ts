/**
 * MS13 - a custom hostname on the project, end to end: activation time, and
 * whether artefacts minted on the origin host still work on the custom one.
 *
 * iap-lockdown L13 measured only that `<ref>.supabase.co` keeps serving after
 * activation. Untested until now: how long initialise -> verified -> active
 * takes with the DNS records in place, which records the platform asks for,
 * TLS on the new name, whether a Storage signed URL created against the
 * origin validates when fetched through the custom host, and Realtime on it.
 * Rows:
 *
 *   MS13a  the `custom_domain` add-on (`cd_default`) applied; `POST
 *          custom-hostname/initialize` status and the records it asks for.
 *   MS13b  DNS written through knotctl (CNAME + the TXT records), then
 *          `reverify` polled: seconds to `3_challenge_verified` or better.
 *   MS13c  `activate` polled to `5_services_reconfigured`: seconds; then
 *          `/auth/v1/health` and `/rest/v1/` on the custom host, TLS issuer.
 *   MS13d  a Storage signed URL created on the origin host, fetched via the
 *          origin and via the custom host; Realtime handshake on the custom
 *          host; origin `/auth/v1/health` still answering.
 *   MS13e  teardown: DELETE custom-hostname, DNS removed, add-on removed.
 *
 * Needs `~/bin/knotctl` with the write key (lab.erfi.io zone). DESTRUCTIVE and
 * BILLABLE: the add-on bills for the hours it is on. Not settled: OAuth or
 * SAML behaviour (no Supabase Auth in the shape under test).
 */
import { $ } from "bun";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addons, applyAddon, errText, removeAddon, sleep } from "../lib/setup";

const KNOTCTL = `${process.env.HOME}/bin/knotctl`;
const HOST = process.env.PVLAB_CUSTOM_HOST ?? "ms13.lab.erfi.io";
// 20 minutes: the first run (2026-09-30) found the platform returns the
// ownership TXT at initialize and the `_acme-challenge` validation TXT only on
// later polls, so verification cannot start until that second record is seen
// and written, and public resolvers then need a few minutes to carry it.
const VERIFY_MAX_MS = 20 * 60_000;
const ACTIVATE_MAX_MS = 10 * 60_000;

interface HostnameCfg {
  status?: string;
  custom_hostname?: string;
  data?: { result?: { ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[]; validation_errors?: { message: string }[] }; ownership_verification?: { type?: string; name?: string; value?: string } } };
}

async function getCfg(ctx: Ctx): Promise<{ status: number; cfg: HostnameCfg; text: string }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`);
  return { status: r.status, cfg: (r.json ?? {}) as HostnameCfg, text: r.text.slice(0, 400) };
}

async function http(url: string, headers: Record<string, string>): Promise<{ status: number; ms: number; err: string }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    return { status: r.status, ms: Date.now() - t0, err: "" };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, err: errText(e) };
  }
}

const mod: TestModule = {
  id: "MS13",
  title: "Custom hostname: add-on, DNS, verification and activation times, origin artefacts on the new host",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const dns: string[][] = []; // records written, for teardown
    const anon = ctx.anonKey ?? "";
    const svc = ctx.serviceKey ?? "";
    let addonApplied = false;
    try {
      // MS13a
      const t0 = Date.now();
      const ad = await addons(ctx);
      let addonStatus = "already selected";
      if (!ad.selected.some((a) => a.type === "custom_domain")) {
        const r = await applyAddon(ctx, "custom_domain", "cd_default");
        addonApplied = r.status < 300;
        addonStatus = `HTTP ${r.status}${r.status >= 300 ? ` ${r.text}` : ""}`;
      }
      const init = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/initialize`, { custom_hostname: HOST });
      const cfg0 = (init.json ?? {}) as HostnameCfg;
      const recs = cfg0.data?.result?.ssl?.validation_records ?? [];
      const own = cfg0.data?.result?.ownership_verification;
      out.push({
        id: "MS13a",
        title: "custom_domain add-on and custom-hostname/initialize",
        status: init.status < 300 ? "pass" : "fail",
        detail: `add-on ${addonStatus}; initialize HTTP ${init.status} status ${cfg0.status ?? "?"}; ${recs.length} TLS validation TXT record(s), ownership record ${own?.type ?? "none"}`,
        measurements: { addon: addonStatus, initialize_http: init.status, initialize_status: cfg0.status ?? "", validation_records: recs.length, ownership_type: own?.type ?? "", elapsed_s: Math.round((Date.now() - t0) / 1000) },
        evidence: init.text.slice(0, 800),
      });
      if (init.status >= 300) return out;

      // MS13b - DNS + reverify
      const t1 = Date.now();
      const cname = await $`${KNOTCTL} add ${HOST} CNAME ${`${ctx.ref}.supabase.co.`}`.quiet().nothrow();
      dns.push([HOST, "CNAME"]);
      const dnsNotes = [`CNAME exit ${cname.exitCode}`];
      for (const r of recs) {
        if (!r.txt_name || !r.txt_value) continue;
        const p = await $`${KNOTCTL} add ${r.txt_name} TXT ${`"${r.txt_value}"`}`.quiet().nothrow();
        dns.push([r.txt_name, "TXT"]);
        dnsNotes.push(`TXT ${r.txt_name} exit ${p.exitCode}`);
      }
      if (own?.name && own.value && own.type?.toLowerCase() === "txt") {
        const p = await $`${KNOTCTL} add ${own.name} TXT ${`"${own.value}"`}`.quiet().nothrow();
        dns.push([own.name, "TXT"]);
        dnsNotes.push(`TXT ${own.name} exit ${p.exitCode}`);
      }
      let cfg = cfg0;
      let verifiedS: number | string = "never";
      let acmeSeenS: number | string = "never";
      let lastErr = "";
      const written = new Set(dns.map(([n]) => n));
      while (Date.now() - t1 < VERIFY_MAX_MS) {
        const rv = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/reverify`);
        cfg = (rv.json ?? {}) as HostnameCfg;
        // Write any TXT the platform is asking for that is not yet in DNS.
        const wanted: { name: string; value: string }[] = [];
        for (const r of cfg.data?.result?.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) wanted.push({ name: r.txt_name, value: r.txt_value });
        const ov = cfg.data?.result?.ownership_verification;
        if (ov?.name && ov.value && ov.type?.toLowerCase() === "txt") wanted.push({ name: ov.name, value: ov.value });
        for (const w of wanted) {
          if (written.has(w.name)) continue;
          const p = await $`${KNOTCTL} add ${w.name} TXT ${`"${w.value}"`}`.quiet().nothrow();
          written.add(w.name);
          dns.push([w.name, "TXT"]);
          dnsNotes.push(`TXT ${w.name} exit ${p.exitCode} at ${Math.round((Date.now() - t1) / 1000)}s`);
          if (w.name.startsWith("_acme-challenge") && acmeSeenS === "never") acmeSeenS = Math.round((Date.now() - t1) / 1000);
        }
        lastErr = (cfg.data?.result?.ssl?.validation_errors ?? []).map((e) => e.message).join("; ").slice(0, 200);
        const st = cfg.status ?? "";
        if (st >= "3_challenge_verified") {
          verifiedS = Math.round((Date.now() - t1) / 1000);
          break;
        }
        await sleep(20_000);
      }
      out.push({
        id: "MS13b",
        title: "DNS written as the platform asks for it, reverify polled to 3_challenge_verified",
        status: verifiedS !== "never" ? "pass" : "fail",
        detail: `${dnsNotes.join(", ")}; ACME validation record first returned at ${acmeSeenS}s; verified after ${verifiedS}s (status ${cfg.status ?? "?"}, ssl ${cfg.data?.result?.ssl?.status ?? "?"})${lastErr ? `; last validation error: ${lastErr}` : ""}`,
        measurements: { verified_s: verifiedS, acme_record_returned_s: acmeSeenS, status_after_verify: cfg.status ?? "", ssl_status: cfg.data?.result?.ssl?.status ?? "", dns_records_written: dns.length },
      });
      if (verifiedS === "never") return out;

      // MS13c - activate
      const t2 = Date.now();
      const act = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/activate`);
      let activeS: number | string = "never";
      while (Date.now() - t2 < ACTIVATE_MAX_MS) {
        const g = await getCfg(ctx);
        if ((g.cfg.status ?? "") >= "5_services_reconfigured") {
          activeS = Math.round((Date.now() - t2) / 1000);
          break;
        }
        await sleep(10_000);
      }
      // The third run (2026-09-30) showed the LAN resolver at this vantage
      // answers 10.0.10.1 for every name under the lab zone (a split-horizon
      // override), so the new name is probed with curl pinned to the address
      // 1.1.1.1 returns for it. TLS still validates against the real hostname.
      const publicIp = async (): Promise<string> => {
        const out = (await $`dig +short @1.1.1.1 ${HOST} A`.quiet().nothrow()).stdout.toString().trim().split("\n").filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
        return out[out.length - 1] ?? "";
      };
      const pinned = async (path: string, headers: string[] = []): Promise<{ status: number; ms: number; err: string; ip: string }> => {
        const ip = await publicIp();
        if (!ip) return { status: 0, ms: 0, err: "no A via 1.1.1.1", ip: "" };
        const t = Date.now();
        const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", "--resolve", `${HOST}:443:${ip}`, ...headers.flatMap((h) => ["-H", h]), `https://${HOST}${path}`];
        const r = await $`curl ${args}`.quiet().nothrow();
        const code = Number(r.stdout.toString().trim()) || 0;
        return { status: code, ms: Date.now() - t, err: code ? "" : r.stderr.toString().trim().slice(-120) || `curl exit ${r.exitCode}`, ip };
      };
      let health = await pinned("/auth/v1/health", [`apikey: ${anon}`]);
      const t3 = Date.now();
      const trace: string[] = [`0s: ip=${health.ip} -> ${health.status || health.err}`];
      while (health.status !== 200 && Date.now() - t3 < 6 * 60_000) {
        await sleep(10_000);
        health = await pinned("/auth/v1/health", [`apikey: ${anon}`]);
        if (Date.now() - t3 > trace.length * 60_000) trace.push(`${Math.round((Date.now() - t3) / 1000)}s: ip=${health.ip} -> ${health.status || health.err}`);
      }
      ctx.log(trace.join(" | "));
      const rest = await pinned("/rest/v1/", [`apikey: ${anon}`]);
      const ipNow = await publicIp();
      const issuer = await $`sh -c ${`echo | openssl s_client -servername ${HOST} -connect ${ipNow}:443 2>/dev/null | openssl x509 -noout -issuer -subject 2>/dev/null`}`.quiet().nothrow();
      out.push({
        id: "MS13c",
        title: "activate polled to 5_services_reconfigured; the custom host answers with TLS",
        status: activeS !== "never" && health.status === 200 ? "pass" : "fail",
        detail: `activate HTTP ${act.status}; reconfigured after ${activeS}s; ${HOST} (pinned to 1.1.1.1's answer) /auth/v1/health ${health.status || health.err} at ${Math.round((Date.now() - t3) / 1000)}s after reconfigure, /rest/v1/ ${rest.status || rest.err}`,
        measurements: { activate_http: act.status, active_s: activeS, custom_auth_health: health.status, custom_auth_first_ok_s: health.status === 200 ? Math.round((Date.now() - t3) / 1000) : "never", custom_rest_root: rest.status, edge_ip_via_1111: ipNow, tls: issuer.stdout.toString().replace(/\s+/g, " ").slice(0, 200), trace: trace.join(" | ").slice(0, 400) },
      });

      // MS13d - origin artefacts through the custom host
      let signedOrigin = { status: 0, ms: 0, err: "no service key" };
      let signedCustom = signedOrigin;
      const bucket = `ms13-${Date.now().toString(36)}`;
      if (svc) {
        const h = { apikey: svc, Authorization: `Bearer ${svc}` };
        await fetch(`https://${ctx.apiHost}/storage/v1/bucket`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: false }) });
        await fetch(`https://${ctx.apiHost}/storage/v1/object/${bucket}/f.txt`, { method: "POST", headers: { ...h, "Content-Type": "text/plain" }, body: "ms13" });
        const sign = await fetch(`https://${ctx.apiHost}/storage/v1/object/sign/${bucket}/f.txt`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }) });
        const sj = (await sign.json().catch(() => ({}))) as { signedURL?: string };
        if (sj.signedURL) {
          signedOrigin = await http(`https://${ctx.apiHost}/storage/v1${sj.signedURL}`, {});
          signedCustom = await pinned(`/storage/v1${sj.signedURL}`);
        } else signedOrigin = { status: sign.status, ms: 0, err: "no signedURL in response" };
        await fetch(`https://${ctx.apiHost}/storage/v1/object/${bucket}`, { method: "DELETE", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: ["f.txt"] }) }).catch(() => {});
        await fetch(`https://${ctx.apiHost}/storage/v1/bucket/${bucket}`, { method: "DELETE", headers: h }).catch(() => {});
      }
      // Realtime: a pinned HTTP upgrade attempt; 101 or a 4xx from the Realtime
      // server both prove the custom host reaches it, a connect error does not.
      const rtProbe = await pinned(`/realtime/v1/websocket?apikey=${anon}&vsn=1.0.0`, ["Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64")}`]);
      const rt = rtProbe.status ? `HTTP ${rtProbe.status}` : `error ${rtProbe.err}`;
      const origin = await http(`https://${ctx.apiHost}/auth/v1/health`, { apikey: anon });
      out.push({
        id: "MS13d",
        title: "origin-minted Storage signed URL via origin and via custom host; Realtime on custom host; origin still serving",
        status: signedOrigin.status === 200 && signedCustom.status === 200 && rtProbe.status > 0 && origin.status === 200 ? "pass" : "info",
        detail: `signed URL via origin ${signedOrigin.status || signedOrigin.err}, via custom host ${signedCustom.status || signedCustom.err}; realtime handshake on custom host: ${rt}; origin /auth/v1/health ${origin.status}`,
        measurements: { signed_via_origin: signedOrigin.status, signed_via_custom: signedCustom.status, realtime_custom: rt, origin_auth_health: origin.status },
      });
    } finally {
      const t4 = Date.now();
      const del = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/custom-hostname`).catch(() => ({ status: 0 }));
      for (const [name, type] of dns) await $`${KNOTCTL} rm ${name} ${type}`.quiet().nothrow();
      const rmAddon = addonApplied ? await removeAddon(ctx, "cd_default") : { status: 0, text: "left as found" };
      out.push({
        id: "MS13e",
        title: "teardown: custom hostname deleted, DNS removed, add-on removed",
        status: "info",
        detail: `DELETE custom-hostname HTTP ${del.status}; ${dns.length} DNS record(s) removed; cd_default DELETE HTTP ${rmAddon.status} ${rmAddon.text}`.slice(0, 300),
        measurements: { delete_http: del.status, dns_removed: dns.length, addon_remove_http: rmAddon.status, teardown_s: Math.round((Date.now() - t4) / 1000) },
      });
    }
    return out;
  },
};
export default mod;
