/**
 * Z02 - does any Management API WRITE wake a parked project?
 *
 * Z01 answers the question for the read surface. This one takes everything the
 * published document carries that Z01's parameter-free GET sweep does not:
 * creates, config mutations, lifecycle calls and deletes, in dependency order.
 *
 *   Z02a  control: SfP-path create comes up healthy on nano.
 *   Z02b  awake pass: run the whole op table against the healthy project. This
 *         is what establishes what each operation DOES, and it is also the only
 *         pass that can capture ids - while parked, the list endpoints that
 *         supply an id are themselves the ones failing.
 *   Z02c  pause, timed.
 *   Z02d  the wake matrix: the same table again, re-reading project status after
 *         every call, with the ids carried over from Z02b. Any status other
 *         than INACTIVE means that operation woke the project.
 *   Z02e  restore, timed, then delete in `finally`.
 *
 * Operations flagged `terminal` in the op table (upgrade, disk resize, addon
 * apply, password rotate) are gated behind PVLAB_S2Z_TERMINAL=1: they are
 * billable or project-ending on a production control plane, and this module is
 * meant to stay safe to point at a staging org without also being a bill.
 *
 * `POST /pause` and `POST /restore` are deliberately absent from the op table -
 * they change project state by definition, so including them would make the
 * "zero wakers" reading meaningless.
 *
 * Scope caveat worth reading before citing a null result: a paused project has
 * no public DNS record, so it is a state traffic cannot wake. See the
 * limitation section in this experiment's README.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { projectStatus, waitStatus } from "../lib/surface.js";
import { WRITE_OPS, UNREACHABLE } from "../lib/write-ops.js";
import { opsTsv, sweepOps, type Captures } from "../lib/sweep.js";

const mod: TestModule = {
  id: "Z02",
  title: "Does any Management API write wake a parked project?",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    const includeTerminal = process.env.PVLAB_S2Z_TERMINAL === "1";
    const ids = ["Z02a", "Z02b", "Z02c", "Z02d", "Z02e"] as const;
    const have = (id: string) => results.some((r) => r.id === id);
    let ref = "";

    try {
      // --- Z02a: control ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `z02-writes-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: "ap-southeast-1",
      });
      ref =
        (create.json as { ref?: string; id?: string } | undefined)?.ref ??
        (create.json as { ref?: string; id?: string } | undefined)?.id ??
        "";
      if (create.status !== 201 || !ref) {
        results.push({
          id: "Z02a",
          title: "Z02a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
        return results;
      }
      const healthy = await waitStatus(ctx, org, ref, "ACTIVE_HEALTHY");
      results.push({
        id: "Z02a",
        title: "Z02a: control",
        status: healthy.reached ? "pass" : "fail",
        detail: healthy.reached
          ? `healthy in ${healthy.seconds}s`
          : `not healthy (saw ${healthy.seen.join(",")})`,
        measurements: {
          provision_s: healthy.seconds,
          ops_in_table: WRITE_OPS.filter((o) => includeTerminal || !o.terminal).length,
          terminal_included: includeTerminal ? 1 : 0,
          unreachable_by_design: UNREACHABLE.length,
        },
      });

      // --- Z02b: awake pass, captures ids for Z02d ---
      const caps: Captures = {};
      const awake = await sweepOps(ctx, WRITE_OPS, {
        ref,
        org,
        includeTerminal,
        caps,
        log: (m) => ctx.log(m),
      });
      const awakeSkips = awake.readings.filter((r) => r.http === "SKIP");
      results.push({
        id: "Z02b",
        title: "Z02b: awake pass over the write surface",
        status: "info",
        detail:
          `${awake.readings.length} ops, ${awakeSkips.length} skipped, ` +
          `${Object.keys(awake.caps).length} ids captured`,
        measurements: {
          ops: awake.readings.length,
          skipped: awakeSkips.length,
          ids_captured: Object.keys(awake.caps).length,
          twoxx: awake.readings.filter((r) => typeof r.http === "number" && r.http >= 200 && r.http < 300).length,
        },
        evidence: opsTsv(awake.readings),
      });

      // --- Z02c: pause ---
      const pause = await mgmt(ctx, "POST", `/projects/${ref}/pause`, {});
      const parked = await waitStatus(ctx, org, ref, "INACTIVE", 600);
      results.push({
        id: "Z02c",
        title: "Z02c: pause",
        status: "info",
        detail: parked.reached
          ? `pause ${pause.status} -> INACTIVE in ${parked.seconds}s via ${parked.seen.join(",")}`
          : `never reached INACTIVE (saw ${parked.seen.join(",")})`,
        measurements: {
          pause_status: pause.status,
          to_inactive_s: parked.seconds,
          reached_inactive: parked.reached ? 1 : 0,
        },
      });

      if (!parked.reached) {
        results.push({ id: "Z02d", title: "Z02d", status: "skip", detail: "project never parked" });
      } else {
        // --- Z02d: wake matrix, ids carried over from Z02b ---
        const paused = await sweepOps(ctx, WRITE_OPS, {
          ref,
          org,
          checkWake: true,
          settleS: 5,
          includeTerminal,
          caps: { ...awake.caps },
          log: (m) => ctx.log(m),
        });
        const exercised = paused.readings.filter((r) => r.http !== "SKIP");
        const wakers = exercised.filter((r) => r.statusAfter && r.statusAfter !== "INACTIVE");
        results.push({
          id: "Z02d",
          title: "Z02d: wake matrix over the write surface",
          status: "info",
          detail:
            wakers.length === 0
              ? `no waker: all ${exercised.length} exercised ops left the project INACTIVE`
              : `WAKERS: ${wakers.map((w) => `${w.verb} ${w.path}`).join(", ")}`,
          measurements: {
            exercised: exercised.length,
            skipped: paused.readings.length - exercised.length,
            wakers: wakers.length,
            slowest_ms: Math.max(...exercised.map((r) => r.ms)),
          },
          evidence: opsTsv(paused.readings),
        });
      }

      // --- Z02e: restore ---
      const st = await projectStatus(ctx, org, ref);
      if (st === "INACTIVE") {
        const restore = await mgmt(ctx, "POST", `/projects/${ref}/restore`, {});
        const back = await waitStatus(ctx, org, ref, "ACTIVE_HEALTHY", 900);
        results.push({
          id: "Z02e",
          title: "Z02e: restore",
          status: "info",
          detail: `restore ${restore.status} -> ${back.reached ? `healthy in ${back.seconds}s` : "TIMEOUT"}`,
          measurements: {
            restore_status: restore.status,
            to_healthy_s: back.seconds,
            reached_healthy: back.reached ? 1 : 0,
          },
        });
      } else {
        results.push({ id: "Z02e", title: "Z02e: restore", status: "skip", detail: `project was ${st}` });
      }

      for (const id of ids) {
        if (!have(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) {
        if (!have(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
      }
    } finally {
      if (ref) {
        const st = await projectStatus(ctx, ctx.orgSlugs[0] ?? "", ref).catch(() => "ERR");
        if (st === "INACTIVE" || st === "PAUSING") {
          await mgmt(ctx, "POST", `/projects/${ref}/restore`, {}).catch(() => null);
          await waitStatus(ctx, ctx.orgSlugs[0] ?? "", ref, "ACTIVE_HEALTHY", 900).catch(() => null);
        }
        await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      }
    }
    return results;
  },
};
export default mod;
