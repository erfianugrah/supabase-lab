/**
 * Z03 - provision the auto-pause fleet: one untouched project per candidate.
 *
 * Phase one of a TWO-RUN experiment, and it deliberately does not wait. An
 * auto-paused project needs days of zero query activity to get there, which no
 * module run can sit through, so this one provisions and exits. Z04 fires the
 * candidates once the fleet has actually parked.
 *
 * The projects are left COMPLETELY UNTOUCHED after create - no probe table, no
 * select, nothing. That is the point: any query resets the inactivity clock,
 * and the clock is the thing being waited on. Even reading the project's API
 * keys is skipped, because Z04's data-plane candidates are sent
 * unauthenticated and the wake question does not need a successful response.
 *
 * Gated behind PVLAB_S2Z_PROVISION=1. It creates one project per candidate and
 * starts a multi-day clock on each; that should never happen because someone
 * ran the suite with --destructive.
 *
 * The fleet manifest is written OUTSIDE the repo (see FLEET_FILE): a project
 * ref is an account identifier, and this repo's identifiers test scans tracked
 * AND add-able files for exactly that shape.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { CANDIDATES, FLEET_FILE } from "../lib/wake-candidates.js";
import { waitStatus } from "../lib/surface.js";

const mod: TestModule = {
  id: "Z03",
  title: "Provision the auto-pause fleet (one project per wake candidate)",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgSlugs[0] ?? "";
    if (process.env.PVLAB_S2Z_PROVISION !== "1") {
      return [
        {
          id: "Z03a",
          title: "Z03a: provision the fleet",
          status: "skip",
          detail:
            `refusing to create ${CANDIDATES.length} projects and start a multi-day clock ` +
            `without PVLAB_S2Z_PROVISION=1`,
        },
      ];
    }

    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const rows: string[] = [];
    const created: { key: string; ref: string; s: number }[] = [];
    const failed: string[] = [];

    for (const c of CANDIDATES) {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `z04-${c.key}-${stamp}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: "ap-southeast-1",
      }).catch(() => null);
      const ref =
        (create?.json as { ref?: string; id?: string } | undefined)?.ref ??
        (create?.json as { ref?: string; id?: string } | undefined)?.id ??
        "";
      if (create?.status !== 201 || !ref) {
        failed.push(`${c.key}: HTTP ${create?.status ?? 0}`);
        continue;
      }
      // Confirm it came up, then never touch it again. waitStatus reads the
      // ORG-scoped listing, which is control plane, not a tenant query.
      const healthy = await waitStatus(ctx, org, ref, "ACTIVE_HEALTHY", 900);
      created.push({ key: c.key, ref, s: healthy.seconds });
      rows.push([c.key, ref, new Date().toISOString(), healthy.reached ? "healthy" : "unhealthy"].join("\t"));
      ctx.log(`provisioned ${c.key} in ${healthy.seconds}s`);
    }

    if (rows.length) {
      const header = "candidate\tref\tprovisioned_utc\tstate";
      await Bun.write(FLEET_FILE, `${header}\n${rows.join("\n")}\n`);
    }

    return [
      {
        id: "Z03a",
        title: "Z03a: provision the fleet",
        status: failed.length === 0 ? "pass" : "fail",
        detail:
          `${created.length}/${CANDIDATES.length} provisioned, manifest at ${FLEET_FILE}` +
          (failed.length ? `; failed: ${failed.join(", ")}` : "") +
          ". Leave the fleet ALONE now - any query restarts the clock.",
        measurements: {
          candidates: CANDIDATES.length,
          provisioned: created.length,
          failed: failed.length,
          slowest_provision_s: created.length ? Math.max(...created.map((c) => c.s)) : 0,
        },
        evidence: `candidate\tprovision_s\n${created.map((c) => `${c.key}\t${c.s}`).join("\n")}`,
      },
    ];
  },
};
export default mod;
