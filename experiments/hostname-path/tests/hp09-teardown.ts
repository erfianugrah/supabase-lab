/**
 * HP09 - Tear down everything HP01..HP08 created: the custom hostname, every
 * DNS record at the names it asked for, the `custom_domain` add-on, the
 * project, and any `hp-*` Docker rig. Then list the account's projects and
 * report whether any with the `hp-` prefix remain.
 *
 * Run it from `make down` after a crash too: it works from `.state.json`.
 * Only the project named in the state file is deleted, and only if its name
 * still starts with the prefix.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cfAvailable, listRecords, removeRecords, zoneId } from "../lib/cfdns";
import { down } from "../lib/resolver";
import { PREFIX, STATE_PATH, loadState } from "../lib/state";
import { rm } from "node:fs/promises";

const mod: TestModule = {
  id: "HP09",
  title: "Teardown: hostname, DNS records, add-on, project, containers",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const st = await loadState();
    const parts: string[] = [];
    let ok = true;
    const m: Record<string, string | number> = {};
    if (st) {
      ctx.ref = st.ref;
      const p = (await mgmt(ctx, "GET", `/projects/${st.ref}`)).json as { name?: string } | undefined;
      if (p?.name && !p.name.startsWith(PREFIX)) return [{ id: "HP09", title: this.title, status: "fail", detail: "state names a project without the hp- prefix; refusing to touch it" }];
      const delHost = await mgmt(ctx, "DELETE", `/projects/${st.ref}/custom-hostname`);
      parts.push(`DELETE custom-hostname HTTP ${delHost.status}`);
      m.delete_hostname_http = delHost.status;
      // What removal does to the Auth redirect_uri: poll the /authorize hop until it names the project hostname again.
      const t0 = Date.now();
      let back: number | string = "not reverted within 180 s";
      let seen = "";
      while (Date.now() - t0 < 180_000) {
        const r = await fetch(`https://${st.ref}.supabase.co/auth/v1/authorize?provider=keycloak&redirect_to=${encodeURIComponent("http://localhost:3000/hp-callback")}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
        try {
          const h = new URL(new URL(r?.headers.get("location") ?? "").searchParams.get("redirect_uri") ?? "").host;
          seen = h === st.host ? "custom" : h === `${st.ref}.supabase.co` ? "origin" : h;
        } catch {
          seen = `HTTP ${r?.status ?? 0}`;
        }
        if (seen === "origin") {
          back = Math.round((Date.now() - t0) / 1000);
          break;
        }
        await Bun.sleep(5_000);
      }
      m.redirect_uri_back_to_origin_after_s = back;
      parts.push(`after DELETE custom-hostname the Auth redirect_uri named the project hostname again after ${back}${typeof back === "number" ? " s" : ""} (last seen ${seen})`);
      if (cfAvailable()) {
        const zone = await zoneId(st.host);
        const names = [...new Set([...st.dnsNames, st.host, `_acme-challenge.${st.host}`, `_cf-custom-hostname.${st.host}`])];
        const removed = await removeRecords(zone, names);
        let left = 0;
        for (const n of names) left += (await listRecords(zone, n)).length;
        parts.push(`${removed} DNS record(s) removed, ${left} left`);
        m.dns_removed = removed;
        m.dns_left = left;
        if (left) ok = false;
      } else {
        parts.push("DNS NOT cleaned (no Cloudflare credentials)");
        ok = false;
      }
      const addon = await mgmt(ctx, "DELETE", `/projects/${st.ref}/billing/addons/cd_default`);
      parts.push(`add-on DELETE HTTP ${addon.status}`);
      m.addon_delete_http = addon.status;
      const del = await mgmt(ctx, "DELETE", `/projects/${st.ref}`);
      parts.push(`project DELETE HTTP ${del.status}`);
      m.project_delete_http = del.status;
      if (del.status >= 300 && del.status !== 404) ok = false;
    } else {
      parts.push("no .state.json");
    }
    await down().catch(() => undefined);

    // Confirm: no project with the prefix remains (the listing can lag a few seconds).
    let remaining: string[] = [];
    for (let i = 0; i < 12; i++) {
      const all = await mgmt(ctx, "GET", "/projects");
      remaining = (Array.isArray(all.json) ? (all.json as { name?: string }[]) : []).map((x) => x.name ?? "").filter((n) => n.startsWith(PREFIX));
      if (!remaining.length) break;
      await Bun.sleep(10_000);
    }
    m.projects_with_prefix_remaining = remaining.length;
    if (remaining.length) ok = false;
    else await rm(STATE_PATH, { force: true });
    return [{ id: "HP09", title: this.title, status: ok ? "pass" : "fail", detail: `${parts.join("; ")}; projects named ${PREFIX}* remaining: ${remaining.length}`, measurements: m }];
  },
};
export default mod;
