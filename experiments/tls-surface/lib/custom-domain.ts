/**
 * Custom hostname lifecycle for TL17, the same sequence medium-serverless
 * MS13 measured on 2026-09-30 (add-on, initialize, DNS as the platform asks
 * for it, reverify, activate), reduced to setup and teardown: here the
 * hostname is the fixture, not the measurement.
 *
 * Two lessons from MS13 carried over: the `_acme-challenge` TXT is returned
 * on a LATER reverify poll than the ownership TXT, so every poll writes
 * whatever is newly asked for; and this vantage's resolver overrides the lab
 * zone (split-horizon), so readiness is probed pinned to 1.1.1.1's answer.
 */
import { $ } from "bun";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";
import { addons, applyAddon, removeAddon, sleep } from "../../medium-serverless/lib/setup";
import { curl, publicA } from "./tls";

const KNOTCTL = `${process.env.HOME}/bin/knotctl`;

interface Cfg {
  status?: string;
  data?: { result?: { ssl?: { validation_records?: { txt_name?: string; txt_value?: string }[] }; ownership_verification?: { type?: string; name?: string; value?: string } } };
}

export interface CdState {
  host: string;
  dns: [string, string][];
  addonApplied: boolean;
  steps: string[];
  ready: boolean;
  ip: string;
}

function asked(cfg: Cfg): { name: string; value: string }[] {
  const w: { name: string; value: string }[] = [];
  for (const r of cfg.data?.result?.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) w.push({ name: r.txt_name, value: r.txt_value });
  const ov = cfg.data?.result?.ownership_verification;
  if (ov?.name && ov.value && ov.type?.toLowerCase() === "txt") w.push({ name: ov.name, value: ov.value });
  return w;
}

export async function setupCustomDomain(ctx: Ctx, host: string, anon: string): Promise<CdState> {
  const s: CdState = { host, dns: [], addonApplied: false, steps: [], ready: false, ip: "" };
  const t0 = Date.now();
  const at = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  const ad = await addons(ctx);
  if (!ad.selected.some((a) => a.type === "custom_domain")) {
    const r = await applyAddon(ctx, "custom_domain", "cd_default");
    s.addonApplied = r.status < 300;
    s.steps.push(`add-on HTTP ${r.status}`);
    if (!s.addonApplied) return s;
  }
  const init = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/initialize`, { custom_hostname: host });
  s.steps.push(`initialize HTTP ${init.status}`);
  if (init.status >= 300) return s;
  const cname = await $`${KNOTCTL} add ${host} CNAME ${`${ctx.ref}.supabase.co.`}`.quiet().nothrow();
  s.dns.push([host, "CNAME"]);
  s.steps.push(`CNAME exit ${cname.exitCode}`);
  const written = new Set<string>();
  let cfg = (init.json ?? {}) as Cfg;
  while (Date.now() - t0 < 20 * 60_000) {
    for (const w of asked(cfg)) {
      if (written.has(w.name)) continue;
      const p = await $`${KNOTCTL} add ${w.name} TXT ${`"${w.value}"`}`.quiet().nothrow();
      written.add(w.name);
      s.dns.push([w.name, "TXT"]);
      s.steps.push(`TXT ${w.name.split(".")[0]} exit ${p.exitCode} at ${at()}`);
    }
    if ((cfg.status ?? "") >= "3_challenge_verified") break;
    await sleep(20_000);
    cfg = ((await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/reverify`)).json ?? {}) as Cfg;
  }
  s.steps.push(`verified ${cfg.status ?? "?"} at ${at()}`);
  if ((cfg.status ?? "") < "3_challenge_verified") return s;
  const act = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/activate`);
  s.steps.push(`activate HTTP ${act.status}`);
  const t1 = Date.now();
  while (Date.now() - t1 < 8 * 60_000) {
    s.ip = await publicA(host);
    if (s.ip) {
      const r = await curl({ url: `https://${host}/auth/v1/health`, pin: { host, ip: s.ip }, headers: [`apikey: ${anon}`], maxTimeS: 10 });
      if (r.code === 200) {
        s.ready = true;
        break;
      }
    }
    await sleep(10_000);
  }
  s.steps.push(`serving ${s.ready ? `at ${at()} via ${s.ip}` : "never"}`);
  return s;
}

export async function teardownCustomDomain(ctx: Ctx, s: CdState): Promise<string> {
  const del = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/custom-hostname`).catch(() => ({ status: 0 }));
  for (const [name, type] of s.dns) await $`${KNOTCTL} rm ${name} ${type}`.quiet().nothrow();
  const rm = s.addonApplied ? await removeAddon(ctx, "cd_default") : { status: 0, text: "left as found" };
  return `DELETE custom-hostname HTTP ${del.status}; ${s.dns.length} DNS record(s) removed; cd_default DELETE HTTP ${rm.status}`;
}
