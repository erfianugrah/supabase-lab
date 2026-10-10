/**
 * HP01 - Provision the throwaway project this experiment measures.
 *
 * Self-provisioning (no OpenTofu state): one project on the Pro org
 * (`PVLAB_ORG_PRO`), name prefix `hp-`, ap-southeast-1, default
 * (micro) compute. Then, so later modules have something to probe:
 *
 *   - a mock OIDC issuer deployed as an Edge Function and wired into the
 *     Keycloak provider slot (lib/idp.ts) - the GitHub-free OAuth path;
 *   - a public bucket `hp-pub` and a private bucket `hp-priv`, one object each;
 *   - a table `hp_items` with one row, and a confirmed password user, for the
 *     app that HP07 runs inside a container.
 *
 * The project ref goes to `.state.json` (gitignored) so HP09 or `make down`
 * can delete it after a crash. Self-skips without a Pro org or a hostname.
 */
import { mgmt } from "../../../harness/src/mgmt";
import { fetchKeys, sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { PREFIX, PW, USER_EMAIL, loadState, saveState, type HpState } from "../lib/state";
import { IDP_SLUG, deployIdp, enableKeycloak } from "../lib/idp";

async function retry(fn: () => Promise<number>, ok: (s: number) => boolean, attempts = 12): Promise<number> {
  let s = 0;
  for (let i = 0; i < attempts; i++) {
    s = await fn().catch(() => 0);
    if (ok(s)) return s;
    await Bun.sleep(10_000);
  }
  return s;
}

const mod: TestModule = {
  id: "HP01",
  title: "Provision: Pro project, mock issuer in the Keycloak slot, buckets, table, user",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro;
    const host = ctx.endpoints.custom_domain;
    if (!org) return [{ id: "HP01", title: this.title, status: "skip", detail: "no PVLAB_ORG_PRO" }];
    if (!host) return [{ id: "HP01", title: this.title, status: "skip", detail: "no PVLAB_ENDPOINT_CUSTOM_DOMAIN" }];
    if (await loadState()) return [{ id: "HP01", title: this.title, status: "fail", detail: ".state.json exists: run `make down` first" }];
    const out: TestResult[] = [];

    const t0 = Date.now();
    const name = `${PREFIX}${t0}`;
    const create = await mgmt(ctx, "POST", "/projects", {
      organization_slug: org,
      name,
      db_pass: `${crypto.randomUUID()}Aa1!`,
      region: "ap-southeast-1",
    });
    const body = (create.json ?? {}) as { ref?: string; id?: string };
    const ref = body.ref ?? body.id ?? "";
    if (!ref) return [{ id: "HP01a", title: "project create", status: "fail", detail: `HTTP ${create.status}: ${create.text.slice(0, 300)}` }];
    const state: HpState = { ref, name, host, createdAt: new Date().toISOString(), anon: "", domainActive: false, dnsNames: [], idpUrl: "" };
    await saveState(state);
    ctx.ref = ref;
    ctx.apiHost = `${ref}.supabase.co`;

    let status = "";
    while (status !== "ACTIVE_HEALTHY" && Date.now() - t0 < 15 * 60_000) {
      await Bun.sleep(10_000);
      status = (((await mgmt(ctx, "GET", `/projects/${ref}`)).json ?? {}) as { status?: string }).status ?? "";
    }
    out.push({
      id: "HP01a",
      title: "project created, healthy",
      status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
      detail: `create HTTP ${create.status}; ${status} after ${Math.round((Date.now() - t0) / 1000)}s`,
      measurements: { create_http: create.status, healthy_s: Math.round((Date.now() - t0) / 1000) },
    });
    if (status !== "ACTIVE_HEALTHY") return out;

    const keys = await fetchKeys(ctx);
    ctx.anonKey = keys.anon;
    ctx.serviceKey = keys.service;
    state.anon = keys.anon;
    state.idpUrl = `https://${ctx.apiHost}/functions/v1/${IDP_SLUG}`;
    await saveState(state);

    // ---- issuer + Keycloak slot ----
    const dep = await deployIdp(ctx);
    let live = 0;
    for (let i = 0; i < 18; i++) {
      live = (await fetch(`${state.idpUrl}/ping`).catch(() => undefined))?.status ?? 0;
      if (live === 200) break;
      await Bun.sleep(5_000);
    }
    const kc = dep.status < 300 ? await enableKeycloak(ctx, keys.anon, state.idpUrl) : { patch: 0, settledS: "not attempted" };
    out.push({
      id: "HP01b",
      title: "mock issuer deployed and wired into the Keycloak slot",
      status: dep.status < 300 && live === 200 && kc.patch < 300 && typeof kc.settledS === "number" ? "pass" : "fail",
      detail: `deploy HTTP ${dep.status}${dep.error ? ` ${dep.error}` : ""}; issuer /ping ${live}; config PATCH HTTP ${kc.patch}; /auth/v1/settings reports keycloak after ${kc.settledS}s`,
      measurements: { deploy_http: dep.status, ping_http: live, patch_http: kc.patch, settled_s: kc.settledS },
    });

    // ---- storage, table, user ----
    const auth = { Authorization: `Bearer ${keys.service}`, apikey: keys.service };
    const sb = `https://${ctx.apiHost}/storage/v1`;
    const bucketStatus: Record<string, number> = {};
    for (const [id, pub] of [["hp-pub", true], ["hp-priv", false]] as const) {
      bucketStatus[id] = await retry(async () => {
        const got = await fetch(`${sb}/bucket/${id}`, { headers: auth });
        if (got.status === 200) return 200;
        return (await fetch(`${sb}/bucket`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ id, name: id, public: pub }) })).status;
      }, (s) => s === 200 || s === 201);
    }
    const objStatus: Record<string, number> = {};
    for (const id of ["hp-pub", "hp-priv"]) {
      objStatus[id] = await retry(async () => (await fetch(`${sb}/object/${id}/hello.txt`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain", "x-upsert": "true" }, body: "hello\n" })).status, (s) => s === 200 || s === 201);
    }
    const ddl = await sql(
      ctx,
      `create table if not exists public.hp_items (id int primary key, label text); insert into public.hp_items values (1,'one') on conflict do nothing; grant select on public.hp_items to anon;`,
    );
    const user = await fetch(`https://${ctx.apiHost}/auth/v1/admin/users`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ email: USER_EMAIL, password: PW, email_confirm: true }),
    });
    out.push({
      id: "HP01c",
      title: "buckets, objects, table, password user",
      status: Object.values(bucketStatus).every((s) => s < 300) && Object.values(objStatus).every((s) => s < 300) && ddl.status < 300 && user.status < 300 ? "pass" : "fail",
      detail: `buckets ${JSON.stringify(bucketStatus)}; objects ${JSON.stringify(objStatus)}; sql HTTP ${ddl.status}${ddl.error ? ` ${ddl.error}` : ""}; user HTTP ${user.status}`,
    });
    return out;
  },
};
export default mod;
