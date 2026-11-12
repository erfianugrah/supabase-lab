/**
 * AU05 - does the custom OAuth/OIDC provider cap on a Pro project lift after
 * an Auth config write through the Management API, and is it the write or
 * elapsed time that lifts it?
 *
 * AU01b measured a cap of 3 custom providers on a Pro-org project; the custom
 * providers docs page says Pro and above have unlimited providers, and
 * platform-facts F01 reads the Pro entitlement `auth.custom_oauth.max_providers`.
 * `GET /v1/projects/{ref}/config/auth` returns `custom_oauth_max_providers`
 * (edge-resilience W17 saw 32767 on one project generation and 3 on another).
 *
 * Two throwaway Pro-org projects, provisioned together:
 *   W (write)    gets PATCH /v1/projects/{ref}/config/auth with site_url only
 *   C (control)  gets no Auth config write
 *
 *   AU05a  both: read custom_oauth_max_providers, then create until refused (max 6)
 *   AU05b  W only: the PATCH, then read custom_oauth_max_providers
 *   AU05c  both: retry each project's refused create every 15 s for up to 3 min
 *   AU05d  both: read custom_oauth_max_providers again; W then creates on to 8
 *
 * Issuer: https://accounts.google.com, whose discovery document resolves;
 * nothing signs in. Both projects are deleted in finally. Destructive
 * (creates billed projects): run with --destructive and PVLAB_ORG_PRO set.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { authFetch, destroyProject, provisionProject, SITE_URL, type Rig } from "../lib/rig.js";

const ISSUER = "https://accounts.google.com";
const body = (n: number) => ({
  provider_type: "oidc",
  identifier: `custom:au5-${n}`,
  name: `AU5 ${n}`,
  client_id: `cid-${n}`,
  client_secret: `unused-${n}`,
  issuer: ISSUER,
  scopes: ["openid", "email"],
});
const errCode = (r: { json?: any }) => String(r.json?.error_code ?? r.json?.code ?? "-");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cap(rig: Rig): Promise<string> {
  const r = await mgmt(rig.ctx, "GET", `/projects/${rig.ref}/config/auth`);
  const v = (r.json as Record<string, unknown> | undefined)?.custom_oauth_max_providers;
  return r.status === 200 ? String(v ?? "absent") : `HTTP ${r.status}`;
}

async function create(rig: Rig, n: number): Promise<string> {
  const r = await authFetch(rig, "POST", "/admin/custom-providers", { body: body(n) });
  return r.status === 201 ? "201" : `${r.status}:${errCode(r)}`;
}

async function fillUntilRefused(rig: Rig, start: number, max: number): Promise<{ next: number; codes: string[]; refused: string }> {
  const codes: string[] = [];
  for (let n = start; n <= max; n++) {
    const c = await create(rig, n);
    codes.push(c);
    if (c !== "201") return { next: n, codes, refused: c };
  }
  return { next: max + 1, codes, refused: "none" };
}

const mod: TestModule = {
  id: "AU05",
  title: "Custom OAuth provider cap: Auth config write vs elapsed time (Pro)",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx) {
    const org = ctx.orgs.pro;
    if (!org) return { id: "AU05", title: "AU05", status: "skip", detail: "PVLAB_ORG_PRO not set" };
    const results: TestResult[] = [];
    const rigs: Rig[] = [];
    try {
      const made = await Promise.allSettled([provisionProject(ctx, org, "au05w", { pro: true }), provisionProject(ctx, org, "au05c", { pro: true })]);
      for (const m of made) if (m.status === "fulfilled") rigs.push(m.value);
      const failed = made.find((m) => m.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) throw new Error(`provision: ${String(failed.reason).slice(0, 300)}`);
      const [w, c] = rigs as [Rig, Rig];

      type Arm = "W" | "C";
      const arms: { label: Arm; rig: Rig }[] = [
        { label: "W", rig: w },
        { label: "C", rig: c },
      ];
      const before = {} as Record<Arm, { next: number; refused: string; cap0: string }>;
      for (const a of arms) {
        const cap0 = await cap(a.rig);
        const f = await fillUntilRefused(a.rig, 1, 6);
        before[a.label] = { next: f.next, refused: f.refused, cap0 };
        results.push({
          id: `AU05a-${a.label}`,
          title: `AU05a-${a.label}: stored cap and creates before any Auth config write`,
          status: "info",
          detail: `custom_oauth_max_providers ${cap0}; created ${f.next - 1}, then ${f.refused}`,
          measurements: { arm: a.label, cap_config_before: cap0, created_before_refusal: f.next - 1, refusal: f.refused, ready_s: a.rig.provisionS },
          evidence: f.codes.join(" "),
        });
      }
      if (before.W.refused === "none" || before.C.refused === "none") {
        results.push({ id: "AU05c", title: "AU05c", status: "skip", detail: "an arm saw no refusal before the write; nothing to retry" });
        return results;
      }

      const t0 = Date.now();
      const patch = await mgmt(w.ctx, "PATCH", `/projects/${w.ref}/config/auth`, { site_url: SITE_URL });
      const capAfterPatch = await cap(w);
      results.push({
        id: "AU05b-W",
        title: "AU05b-W: PATCH /config/auth (site_url only), then the stored cap",
        status: patch.status < 300 ? "info" : "fail",
        detail: `HTTP ${patch.status}; custom_oauth_max_providers ${capAfterPatch}`,
        measurements: { patch_status: patch.status, cap_config_after_patch: capAfterPatch },
      });

      const acceptedAt: Record<Arm, number> = { W: -1, C: -1 };
      const trail: Record<Arm, string[]> = { W: [], C: [] };
      while (Date.now() - t0 < 180_000 && (acceptedAt.W < 0 || acceptedAt.C < 0)) {
        await sleep(15_000);
        for (const a of arms) {
          if (acceptedAt[a.label] >= 0) continue;
          const code = await create(a.rig, before[a.label].next);
          const s = Math.round((Date.now() - t0) / 1000);
          trail[a.label].push(`${s}s:${code}`);
          if (code === "201") acceptedAt[a.label] = s;
        }
      }
      for (const a of arms) {
        const capNow = await cap(a.rig);
        results.push({
          id: `AU05c-${a.label}`,
          title: `AU05c-${a.label}: retries of the refused create, every 15 s for up to 180 s from the PATCH request`,
          status: "info",
          detail: acceptedAt[a.label] >= 0 ? `accepted on the retry sent ${acceptedAt[a.label]} s after the PATCH request; custom_oauth_max_providers now ${capNow}` : `still refused at 180 s; custom_oauth_max_providers now ${capNow}`,
          measurements: { arm: a.label, accepted_at_s: acceptedAt[a.label], retries: trail[a.label].length, cap_config_end: capNow },
          evidence: trail[a.label].join(" "),
        });
      }
      if (acceptedAt.W >= 0) {
        const more = await fillUntilRefused(w, before.W.next + 1, 8);
        results.push({
          id: "AU05d-W",
          title: "AU05d-W: create on to 8 providers after the write",
          status: "info",
          detail: `total ${more.next - 1}, then ${more.refused}`,
          measurements: { total_providers: more.next - 1, refusal_after: more.refused },
          evidence: more.codes.join(" "),
        });
      }
    } finally {
      for (const r of rigs) {
        const d = await destroyProject(ctx, r.ref);
        results.push({ id: `AU05-teardown-${rigs.indexOf(r) === 0 ? "W" : "C"}`, title: "AU05: delete throwaway project", status: d < 300 ? "info" : "fail", detail: `HTTP ${d}`, measurements: { delete_status: d } });
      }
    }
    return results;
  },
};

export default mod;
