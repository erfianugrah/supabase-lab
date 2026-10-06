/**
 * HS04 - Bring up the one documented exception: a custom domain on the
 * project ("Serving of HTML content is only supported with custom domains").
 * HS05-domain then loads the Astro build through it in a browser.
 *
 * Side: the lab project's custom-hostname surface (Management API), DNS in a
 * Cloudflare-hosted zone written through the CF v4 API (lib/cfdns.ts). The
 * flow is medium-serverless MS13's, ported off knotctl:
 *
 *   HS04a  `custom_domain` add-on (`cd_default`) + `custom-hostname/initialize`
 *   HS04b  CNAME <host> -> <ref>.supabase.co and every TXT the platform asks
 *          for (the `_acme-challenge` record arrives on a later poll, MS13);
 *          `reverify` polled every 20 s to `3_challenge_verified`
 *   HS04c  `activate` polled to `5_services_reconfigured`, then the function
 *          root and a Storage object through the custom host (curl pinned to
 *          1.1.1.1's answer): status and content-type
 *
 * Idempotent: an already-active hostname is reported and left alone.
 *
 * DESTRUCTIVE and BILLABLE ($10/month add-on, hourly). Deliberately NOT torn
 * down here - the point is a URL someone can open. HS07 tears it down. The
 * custom domain becomes the project's primary Auth domain (OAuth callbacks,
 * SAML EntityID); nothing on this project uses either. Self-skips without
 * PVLAB_ENDPOINT_CUSTOM_DOMAIN or Cloudflare credentials.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { type ActivateOutcome, activateWithRetry } from "../lib/activate";
import { cfAvailable, pinnedGet, publicIp, upsertRecord, zoneId } from "../lib/cfdns";
import { ensureSite } from "../lib/site";

const VERIFY_MAX_MS = 20 * 60_000;
const ACTIVATE_MAX_MS = 10 * 60_000;

interface HostnameCfg {
  status?: string;
  custom_hostname?: string;
  data?: {
    result?: {
      ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[]; validation_errors?: { message: string }[] };
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

const mod: TestModule = {
  id: "HS04",
  title: "Custom domain up (the documented exception), DNS via Cloudflare",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const host = ctx.endpoints.custom_domain;
    if (!ctx.ref || !host) return [{ id: "HS04", title: this.title, status: "skip", detail: "no PVLAB_ENDPOINT_CUSTOM_DOMAIN" }];
    if (!cfAvailable()) return [{ id: "HS04", title: this.title, status: "skip", detail: "no CLOUDFLARE_API_KEY/CLOUDFLARE_EMAIL in the environment" }];
    const out: TestResult[] = [];

    const cur = await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`);
    const curCfg = (cur.json ?? {}) as HostnameCfg;
    let activeS: number | string = "already active";
    let activation: ActivateOutcome | undefined;
    if (curCfg.custom_hostname === host && (curCfg.status ?? "") >= "5_services_reconfigured") {
      out.push({ id: "HS04a", title: "custom hostname already active", status: "info", detail: `status ${curCfg.status}`, measurements: { status: curCfg.status ?? "" } });
    } else {
      // ---- HS04a ----
      const ad = await mgmt(ctx, "GET", `/projects/${ctx.ref}/billing/addons`);
      const selected = ((ad.json as { selected_addons?: { type: string }[] } | undefined)?.selected_addons ?? []).map((a) => a.type);
      let addon = "already selected";
      if (!selected.includes("custom_domain")) {
        const r = await mgmt(ctx, "PATCH", `/projects/${ctx.ref}/billing/addons`, { addon_type: "custom_domain", addon_variant: "cd_default" });
        addon = `HTTP ${r.status}${r.status >= 300 ? ` ${r.text.slice(0, 200)}` : ""}`;
      }
      const init = await mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/initialize`, { custom_hostname: host });
      const cfg0 = (init.json ?? {}) as HostnameCfg;
      out.push({
        id: "HS04a",
        title: "custom_domain add-on and custom-hostname/initialize",
        status: init.status < 300 ? "pass" : "fail",
        detail: `add-on ${addon}; initialize HTTP ${init.status} status ${cfg0.status ?? "?"}; ${wantedTxt(cfg0).length} TXT record(s) asked for${init.status >= 300 ? `; ${init.text.slice(0, 200)}` : ""}`,
        measurements: { addon, initialize_http: init.status, initialize_status: cfg0.status ?? "" },
      });
      if (init.status >= 300) return out;

      // ---- HS04b ----
      const zone = await zoneId(host);
      const t1 = Date.now();
      const notes: string[] = [];
      const cname = await upsertRecord(zone, "CNAME", host, `${ctx.ref}.supabase.co`);
      notes.push(`CNAME ${cname.status}${cname.error ? ` ${cname.error}` : ""}`);
      const written = new Set<string>();
      const writeWanted = async (cfg: HostnameCfg) => {
        for (const w of wantedTxt(cfg)) {
          const k = `${w.name}=${w.value}`;
          if (written.has(k)) continue;
          const r = await upsertRecord(zone, "TXT", w.name, w.value);
          written.add(k);
          notes.push(`TXT ${w.name.split(".")[0]} ${r.status}${r.error ? ` ${r.error}` : ""} at ${Math.round((Date.now() - t1) / 1000)}s`);
        }
      };
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
      const lastErr = (cfg.data?.result?.ssl?.validation_errors ?? []).map((e) => e.message).join("; ").slice(0, 200);
      out.push({
        id: "HS04b",
        title: "DNS written as asked; reverify polled to 3_challenge_verified",
        status: verifiedS !== "never" ? "pass" : "fail",
        detail: `${notes.join(", ")}; verified after ${verifiedS}s (status ${cfg.status ?? "?"})${lastErr ? `; last validation error: ${lastErr}` : ""}`,
        measurements: { verified_s: verifiedS, status_after_verify: cfg.status ?? "", dns_writes: notes.length },
      });
      if (verifiedS === "never") return out;

      // ---- HS04c: activate ----
      // On the first live run (2026-10-06) activate answered 400 immediately
      // after reverify reported 4_origin_setup_completed; the same call by hand
      // about ten minutes later answered 201. The 400 body was not recorded, so
      // the cause is open: wait for 4, retry for up to 10 minutes, and keep the
      // first refusal's body in the log.
      const t2 = Date.now();
      let st = cfg.status ?? "";
      while (st < "4_origin_setup_completed" && Date.now() - t2 < ACTIVATE_MAX_MS) {
        await Bun.sleep(10_000);
        st = (((await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`)).json ?? {}) as HostnameCfg).status ?? "";
      }
      const origin4S = Math.round((Date.now() - t2) / 1000);
      activation = await activateWithRetry(
        () => mgmt(ctx, "POST", `/projects/${ctx.ref}/custom-hostname/activate`),
        (ms) => Bun.sleep(ms),
      );
      ctx.log(`HS04 origin setup after ${origin4S}s; first activate ${activation.first}; ${activation.attempts} attempt(s), last HTTP ${activation.lastStatus}`);
      activeS = "never";
      while (Date.now() - t2 < ACTIVATE_MAX_MS) {
        const g = await mgmt(ctx, "GET", `/projects/${ctx.ref}/custom-hostname`);
        if ((((g.json ?? {}) as HostnameCfg).status ?? "") >= "5_services_reconfigured") {
          activeS = Math.round((Date.now() - t2) / 1000);
          break;
        }
        await Bun.sleep(10_000);
      }
      ctx.log(`HS04 reconfigured after ${activeS}s`);
    }

    // Serving check: the name answers through the edge, pinned to 1.1.1.1.
    // The probe object has to exist on THIS project: until 2026-10-06 only HS01
    // created the `site` bucket, so `make domain-up` (HS04+HS05) on a fresh
    // project probed a missing object - 400 on one run, and on another a 200
    // the project could not have served (edge cache of an earlier project's
    // object is the guess; cf-cache-status was not recorded then).
    await ensureSite(ctx);
    const t3 = Date.now();
    let ip = await publicIp(host);
    let probe = ip
      ? await pinnedGet(host, ip, "/storage/v1/object/public/site/robots.txt")
      : { status: 0, contentType: "", location: "", cfCache: "", err: "no A via 1.1.1.1" };
    while (probe.status !== 200 && Date.now() - t3 < 6 * 60_000) {
      await Bun.sleep(10_000);
      ip = await publicIp(host);
      probe = ip ? await pinnedGet(host, ip, "/storage/v1/object/public/site/robots.txt") : probe;
    }
    const html = ip ? await pinnedGet(host, ip, "/storage/v1/object/public/site/index.html") : probe;
    out.push({
      id: "HS04c",
      title: "Custom host active and serving (curl pinned to 1.1.1.1's answer)",
      status: probe.status === 200 ? "pass" : "fail",
      detail: `${activation ? `activate ${activation.first} (${activation.attempts} attempt(s), last ${activation.lastStatus}); ` : ""}reconfigured ${activeS}${typeof activeS === "number" ? "s" : ""}; robots.txt ${probe.status || probe.err} after ${Math.round((Date.now() - t3) / 1000)}s; storage index.html ${html.status} "${html.contentType}"`,
      measurements: {
        first_activate: activation?.first ?? "not called (already active)",
        activate_attempts: activation?.attempts ?? 0,
        active_s: activeS, serving_after_s: Math.round((Date.now() - t3) / 1000), robots_status: probe.status, robots_cf_cache: probe.cfCache || "none", storage_html_status: html.status, storage_html_ct: html.contentType || "none" },
    });
    return out;
  },
};
export default mod;
