/**
 * HP03 - Custom domain up on the Pro project: `custom_domain` add-on,
 * `custom-hostname/initialize`, every DNS record the platform asks for written
 * into the Cloudflare-hosted zone, `reverify` polled to `3_challenge_verified`,
 * `activate` to `5_services_reconfigured`, then the host answers.
 *
 * Same flow as static-hosting HS04 / medium-serverless MS13, on a fresh
 * project, so the timings are one more sample of an already-measured path; the
 * part that is new here is what the host does for OAuth and the SDK
 * (HP04, HP05).
 *
 * BILLABLE ($10/month add-on, hourly). HP09 tears it down.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { addRecord, cfAvailable, zoneId } from "../lib/cfdns";
import { dig, run } from "../lib/net";
import { saveState, useState } from "../lib/state";

interface HostnameCfg {
  status?: string;
  custom_hostname?: string;
  data?: {
    result?: {
      ssl?: { validation_records?: { txt_name?: string; txt_value?: string }[]; validation_errors?: { message: string }[] };
      ownership_verification?: { type?: string; name?: string; value?: string };
    };
  };
}

function wantedTxt(cfg: HostnameCfg): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const r of cfg.data?.result?.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) out.push({ name: r.txt_name, value: r.txt_value });
  const ov = cfg.data?.result?.ownership_verification;
  if (ov?.name && ov.value && ov.type?.toLowerCase() === "txt") out.push({ name: ov.name, value: ov.value });
  return out;
}

const VERIFY_MAX_MS = 20 * 60_000;
const ACTIVATE_MAX_MS = 12 * 60_000;

const mod: TestModule = {
  id: "HP03",
  title: "Custom domain up: add-on, hostname, DNS via Cloudflare, verify, activate",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await useState(ctx);
    if (!st) return [{ id: "HP03", title: this.title, status: "skip", detail: "no .state.json (HP01 did not run)" }];
    if (!cfAvailable()) return [{ id: "HP03", title: this.title, status: "skip", detail: "no CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL in the environment" }];
    const host = st.host;
    const out: TestResult[] = [];

    // ---- a: add-on + initialize ----
    const addon = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/billing/addons`, { addon_type: "custom_domain", addon_variant: "cd_default" });
    const init = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/initialize`, { custom_hostname: host });
    const cfg0 = (init.json ?? {}) as HostnameCfg;
    out.push({
      id: "HP03a",
      title: "custom_domain add-on and custom-hostname/initialize",
      status: init.status < 300 ? "pass" : "fail",
      detail: `add-on PATCH HTTP ${addon.status}${addon.status >= 300 ? ` ${addon.text.slice(0, 160)}` : ""}; initialize HTTP ${init.status}, status ${cfg0.status ?? "?"}, ${wantedTxt(cfg0).length} TXT record(s) asked for${init.status >= 300 ? `; ${init.text.slice(0, 200)}` : ""}`,
      measurements: { addon_http: addon.status, initialize_http: init.status, initialize_status: cfg0.status ?? "" },
    });
    if (init.status >= 300) return out;

    // ---- b: DNS + verify ----
    const zone = await zoneId(host);
    const t1 = Date.now();
    const notes: string[] = [];
    const names = new Set<string>([host]);
    const cname = await addRecord(zone, "CNAME", host, `${ctx.ref}.supabase.co`);
    notes.push(`CNAME ${cname.status}${cname.error ? ` ${cname.error}` : ""}`);
    const written = new Set<string>();
    const writeWanted = async (cfg: HostnameCfg) => {
      for (const w of wantedTxt(cfg)) {
        const k = `${w.name}=${w.value}`;
        if (written.has(k)) continue;
        const r = await addRecord(zone, "TXT", w.name, w.value);
        written.add(k);
        names.add(w.name);
        notes.push(`TXT ${w.name.split(".")[0]} ${r.status}${r.error ? ` ${r.error}` : ""} at ${Math.round((Date.now() - t1) / 1000)}s`);
      }
    };
    st.dnsNames = [...names, `_acme-challenge.${host}`, `_cf-custom-hostname.${host}`];
    await saveState(st);
    await writeWanted(cfg0);
    let cfg = cfg0;
    let verifiedS: number | string = "never";
    while (Date.now() - t1 < VERIFY_MAX_MS) {
      const rv = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/reverify`);
      cfg = (rv.json ?? {}) as HostnameCfg;
      await writeWanted(cfg);
      if ((cfg.status ?? "") >= "3_challenge_verified") {
        verifiedS = Math.round((Date.now() - t1) / 1000);
        break;
      }
      await Bun.sleep(20_000);
    }
    out.push({
      id: "HP03b",
      title: "DNS written as asked; reverify polled to 3_challenge_verified",
      status: verifiedS !== "never" ? "pass" : "fail",
      detail: `${notes.join(", ")}; verified after ${verifiedS}s (status ${cfg.status ?? "?"})`,
      measurements: { verified_s: verifiedS, status_after_verify: cfg.status ?? "", dns_writes: notes.length },
    });
    if (verifiedS === "never") return out;

    // ---- c: activate ----
    const t2 = Date.now();
    let status = cfg.status ?? "";
    while (status < "4_origin_setup_completed" && Date.now() - t2 < ACTIVATE_MAX_MS) {
      await Bun.sleep(10_000);
      status = (((await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`)).json ?? {}) as HostnameCfg).status ?? "";
    }
    const origin4S = Math.round((Date.now() - t2) / 1000);
    let first = "";
    let attempts = 0;
    let last = 0;
    while (Date.now() - t2 < ACTIVATE_MAX_MS) {
      const a = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/activate`);
      attempts++;
      last = a.status;
      if (!first) first = `HTTP ${a.status}${a.status >= 300 ? ` ${a.text.slice(0, 160)}` : ""}`;
      if (a.status < 300) break;
      await Bun.sleep(15_000);
    }
    let activeS: number | string = "never";
    while (Date.now() - t2 < ACTIVATE_MAX_MS) {
      const g = (await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`)).json as HostnameCfg | undefined;
      if ((g?.status ?? "") >= "5_services_reconfigured") {
        activeS = Math.round((Date.now() - t2) / 1000);
        break;
      }
      await Bun.sleep(10_000);
    }
    st.domainActive = activeS !== "never";
    await saveState(st);

    // ---- serving: poll the host via 1.1.1.1's answer, then via the system resolver ----
    const t3 = Date.now();
    let code = 0;
    let ip = "";
    while (Date.now() - t3 < 8 * 60_000) {
      const a = await dig("1.1.1.1", host, "A");
      ip = a.answers.filter((x) => x.type === "A").pop()?.data ?? "";
      if (ip) {
        const r = await run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", "--resolve", `${host}:443:${ip}`, `https://${host}/functions/v1/hp-mock-idp/ping`]);
        code = Number(r.out) || 0;
        if (code === 200) break;
      }
      await Bun.sleep(10_000);
    }
    const servedS = code === 200 ? Math.round((Date.now() - t3) / 1000) : "never";
    const sys = await dig(undefined, host, "A");
    const activeAt = typeof activeS === "number" ? t2 + activeS * 1000 : Date.now();
    out.push({
      id: "HP03c",
      title: "activate to 5_services_reconfigured; the host serves",
      status: code === 200 ? "pass" : "fail",
      detail: `origin setup (4_) after ${origin4S}s; activate first ${first || "not called"}, ${attempts} attempt(s), last HTTP ${last}; reconfigured ${activeS}${typeof activeS === "number" ? "s" : ""}; function ping through the custom host (curl pinned to 1.1.1.1's answer) ${code} after ${servedS}${typeof servedS === "number" ? "s" : ""}; system resolver answers ${sys.rcode} with ${sys.answers.length} record(s)`,
      measurements: { origin_setup_s: origin4S, activate_attempts: attempts, activate_first: first.slice(0, 40), active_s: activeS, serving_s: servedS, ping_status: code, system_resolver_rcode: sys.rcode },
    });

    // ---- d: when does the Auth server start using the custom host in redirect_uri? ----
    // First live run (2026-10-10): a round trip started right after
    // `5_services_reconfigured` put the project hostname in redirect_uri, the
    // same round trip about a minute later put the custom host there. Poll the
    // /authorize hop (entered at each host) and record the first time each
    // answers with the custom host, counted from the moment the API reported 5_.
    const redirectHost = async (entry: string): Promise<string> => {
      const r = await fetch(`https://${entry}/auth/v1/authorize?provider=keycloak&redirect_to=${encodeURIComponent("http://localhost:3000/hp-callback")}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
      const loc = r?.headers.get("location") ?? "";
      try {
        const h = new URL(new URL(loc).searchParams.get("redirect_uri") ?? "").host;
        return h === host ? "custom" : h === `${ctx.ref}.supabase.co` ? "origin" : h || "none";
      } catch {
        return `HTTP ${r?.status ?? 0}`;
      }
    };
    const seq: string[] = [];
    let flipS: number | string = "never within 15 min";
    let lastSeq = "";
    while (Date.now() - activeAt < 15 * 60_000) {
      const viaOrigin = await redirectHost(`${ctx.ref}.supabase.co`);
      const viaCustom = await redirectHost(host);
      const s = Math.round((Date.now() - activeAt) / 1000);
      const cur = `origin-entry:${viaOrigin} custom-entry:${viaCustom}`;
      if (cur !== lastSeq) seq.push(`${s}s ${cur}`);
      lastSeq = cur;
      if (viaOrigin === "custom" && viaCustom === "custom") {
        flipS = s;
        break;
      }
      await Bun.sleep(5_000);
    }
    out.push({
      id: "HP03d",
      title: "seconds from 5_services_reconfigured until the Auth redirect_uri carries the custom host",
      status: typeof flipS === "number" ? "pass" : "fail",
      detail: `transitions (seconds counted from the API reporting 5_services_reconfigured): ${seq.join(" | ")}`,
      measurements: { redirect_uri_custom_after_s: flipS, transitions: seq.join(" | ") },
    });
    return out;
  },
};
export default mod;
