/**
 * OR09 - is point-in-time recovery available on an OrioleDB project?
 *
 * Same calls on the OrioleDB project and the heap control (same size, small):
 *
 *   OR09a  before: `GET /billing/addons` (does the catalogue list `pitr` and
 *          its variants for the project) and `GET /database/backups`
 *          (`walg_enabled`, `pitr_enabled`, `physical_backup_data`), per project.
 *   OR09b  `PATCH /billing/addons` with `{addon_type: "pitr", addon_variant:
 *          "pitr_7"}` on each project. Records the HTTP status and the first
 *          300 bytes of the body. A 429 "try again in N minute(s)" is retried
 *          up to 3 times. This starts billing for the PITR add-on on the
 *          project until the project is deleted (minutes).
 *   OR09c  if the call was accepted: poll `GET /database/backups` every 20 s
 *          for up to OR_PITR_WAIT_S seconds (default 600) until
 *          `pitr_enabled` is true; record the seconds it took, or the final
 *          state.
 *
 * Not settled: a restore. No `restore-pitr` call is made, so whether an
 * OrioleDB project's WAL can actually be replayed to a timestamp is not
 * measured here, only whether the platform offers and enables the add-on.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt";
import { ensurePair, skipWithoutOrg, sleep, type Proj } from "../lib/pair";

const ID = "OR09";

async function backups(ctx: Ctx, p: Proj): Promise<Record<string, string | number>> {
  const r = await mgmt(ctx, "GET", `/projects/${p.ref}/database/backups`);
  const j = (r.json ?? {}) as { walg_enabled?: boolean; pitr_enabled?: boolean; physical_backup_data?: Record<string, unknown>; backups?: unknown[] };
  return {
    http: r.status,
    walg_enabled: String(j.walg_enabled),
    pitr_enabled: String(j.pitr_enabled),
    physical_backup_keys: Object.keys(j.physical_backup_data ?? {}).join(",") || "(empty)",
    daily_backups_listed: Array.isArray(j.backups) ? j.backups.length : -1,
  };
}

async function addons(ctx: Ctx, p: Proj): Promise<Record<string, string | number>> {
  const r = await mgmt(ctx, "GET", `/projects/${p.ref}/billing/addons`);
  const j = (r.json ?? {}) as { available_addons?: Array<{ type?: string; variants?: Array<{ id?: string; identifier?: string }> }>; selected_addons?: Array<{ type?: string; addon_type?: string; variant?: { identifier?: string }; addon_variant?: string }> };
  const pitr = (j.available_addons ?? []).find((a) => a.type === "pitr");
  return {
    http: r.status,
    pitr_in_catalogue: pitr ? (pitr.variants ?? []).map((v) => v.id ?? v.identifier ?? "?").join("|") : "(not listed)",
    selected: (j.selected_addons ?? []).map((a) => `${a.type ?? a.addon_type}=${a.variant?.identifier ?? a.addon_variant ?? "default"}`).join(","),
  };
}

const mod: TestModule = {
  id: ID,
  title: "PITR add-on on an OrioleDB project vs the heap control",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult[]> {
    const skipped = skipWithoutOrg(ctx, ID, this.title);
    if (skipped) return skipped;
    const out: TestResult[] = [];
    const pair = await ensurePair(ctx);
    const projs = [pair.oriole, pair.heap];
    const waitS = Number(process.env.OR_PITR_WAIT_S ?? "600");

    for (const p of projs) {
      const [ad, bk] = await Promise.all([addons(ctx, p), backups(ctx, p)]);
      const m: Record<string, string | number> = { project: p.role };
      for (const [k, v] of Object.entries(ad)) m[`addons_${k}`] = v;
      for (const [k, v] of Object.entries(bk)) m[`backups_${k}`] = v;
      out.push({ id: `${ID}a-${p.role}`, title: `OR09a: catalogue and backup state before (${p.role})`, status: "info", measurements: m });
    }

    const accepted: Record<string, boolean> = {};
    const t0 = Date.now();
    for (const p of projs) {
      const call = () => mgmt(ctx, "PATCH", `/projects/${p.ref}/billing/addons`, { addon_type: "pitr", addon_variant: "pitr_7" });
      let r: MgmtResponse = await call();
      for (let i = 0; i < 3 && r.status === 429; i++) {
        const mm = /try again in (\d+) minute/.exec(r.text);
        await sleep((mm ? Number(mm[1]) * 60 + 15 : 75) * 1000);
        r = await call();
      }
      accepted[p.role] = r.status >= 200 && r.status < 300;
      out.push({
        id: `${ID}b-${p.role}`,
        title: `OR09b: enable pitr_7 (${p.role})`,
        status: "info",
        detail: `HTTP ${r.status}: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`,
        measurements: { project: p.role, http: r.status, body: r.text.replace(/\s+/g, " ").slice(0, 300) },
      });
    }

    for (const p of projs) {
      if (!accepted[p.role]) {
        out.push({ id: `${ID}c-${p.role}`, title: `OR09c: PITR state after enable (${p.role})`, status: "skip", detail: "the add-on call was not accepted" });
        continue;
      }
      let enabled = -1;
      let last: Record<string, string | number> = {};
      while ((Date.now() - t0) / 1000 < waitS) {
        last = await backups(ctx, p);
        if (last.pitr_enabled === "true") {
          enabled = Math.round((Date.now() - t0) / 1000);
          break;
        }
        await sleep(20_000);
      }
      const pr = await mgmt(ctx, "GET", `/projects/${p.ref}`);
      out.push({
        id: `${ID}c-${p.role}`,
        title: `OR09c: PITR state after enable (${p.role})`,
        status: "info",
        detail: enabled >= 0 ? `pitr_enabled true after ${enabled} s from the first PATCH` : `pitr_enabled still ${last.pitr_enabled} after ${waitS} s`,
        measurements: {
          project: p.role,
          seconds_to_pitr_enabled: enabled,
          wait_cap_s: waitS,
          final_walg_enabled: String(last.walg_enabled),
          final_pitr_enabled: String(last.pitr_enabled),
          project_status: String((pr.json as { status?: string } | undefined)?.status ?? `HTTP ${pr.status}`),
        },
      });
    }
    return out;
  },
};

export default mod;
