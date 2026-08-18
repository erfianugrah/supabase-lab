/**
 * I03 - Legacy paused project lifecycle.
 *
 * This module touches a PRE-EXISTING project (ref from ctx).
 * It must NEVER delete, rename, or reconfigure it - only restore, read, and pause.
 * The project may be left AWAKE and billing if the pause attempt is rejected.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

// The legacy free-era project under test (created before the org moved to a
// paid plan; it sits INACTIVE while paid-plan projects cannot be paused).
const LEGACY_REF = "yanbxwcrnumsefavdoqw";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mod: TestModule = {
  id: "I03",
	title: "Legacy paused project lifecycle (destructive)",
	where: "local",
	requires: ["pat"],
	destructive: true,
	async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];

    // I03-control
    let initialStatus = "unknown";
    let controlStatus: "pass" | "fail" = "pass";
    let controlDetail = "";

    try {
      const p = await mgmt(ctx, "GET", `/projects/${LEGACY_REF}`);
      if (p.status === 200) {
        const json = p.json as { status?: string } | undefined;
        initialStatus = json?.status ?? "unknown";
      } else {
        controlStatus = "fail";
        controlDetail = `HTTP ${p.status}`;
      }

      results.push({
        id: "I03-control",
        title: "I03-control: check initial status",
        status: controlStatus,
        detail: controlDetail,
        measurements: { initial_status: initialStatus },
      });

      // If project is not INACTIVE, skip lifecycle tests
      if (initialStatus !== "INACTIVE") {
        const skipDetail = "project was not paused at run start";
        results.push({
          id: "I03a",
          title: "I03a: restore project",
          status: "skip",
          detail: skipDetail,
        });
        results.push({
          id: "I03b",
          title: "I03b: pause project",
          status: "skip",
          detail: skipDetail,
        });
        return results;
      }

      // I03a: Restore
      let i03aResult: TestResult = {
        id: "I03a",
        title: "I03a: restore and check compute",
        status: "info",
        measurements: { wake_s: -1, compute: "unknown" },
      };

      const restore = await mgmt(ctx, "POST", `/projects/${LEGACY_REF}/restore`);
      const restoreStatus = restore.status;
      let wakeS = -1;
      let compute = "unknown";
      let i03aHealthy = false;

      if (restore.status >= 200 && restore.status < 300) {
        const t0 = Date.now();
        // Poll until ACTIVE_HEALTHY (max 20 min, every 15s)
        for (let i = 0; i < 80; i++) {
          await sleep(15_000);
          const p = await mgmt(ctx, "GET", `/projects/${ctx.
            ref
          }`);
          const json = p.json as { status?: string } | undefined;
          if (json?.status === "ACTIVE_HEALTHY") {
            wakeS = Math.round((Date.now() - t0) / 1000);
            i03aHealthy = true;
            break;
          }
        }

        // Get compute info
        try {
          const addons = await mgmt(ctx, "GET", `/projects/${LEGACY_REF}/billing/addons`);
          const addonsJson = addons.json as { selected_addons?: string[] } | undefined;
          compute = addonsJson?.selected_addons?.length
            ? addonsJson.selected_addons.join(",")
            : "none(micro)";
        } catch {
          compute = "unknown";
        }

        i03aResult = {
          id: "I03a",
          title: "I03a: restore and check compute",
          status: "info",
          measurements: {
            restore_http_status: restoreStatus,
            wake_s: wakeS,
            compute: compute,
          },
        };
      } else {
        i03aResult = {
          id: "I03a",
          title: "I03a: restore and check compute",
          status: "info",
          measurements: {
            restore_http_status: restoreStatus,
            wake_s: -1,
            compute: "unknown",
          },
          evidence: restore.text.slice(0, 300),
        };
      }
      results.push(i03aResult);

      // I03b: Pause
      let i03bResult: TestResult = {
        id: "I03b",
        title: "I03b: pause and check status",
        status: "info",
        measurements: { pause_status: 0 },
      };

      if (i03aHealthy) {
        const pause = await mgmt(ctx, "POST", `/projects/${LEGACY_REF}/pause`);
        const pauseStatus = pause.status;
        let repauseS = 0;
        let pauseEvidence = "";

        if (pause.status >= 200 && pause.status < 300) {
          const t0 = Date.now();
          // Poll back to INACTIVE (max 10 min, every 15s)
          for (let i = 0; i < 40; i++) {
            await sleep(15_000);
            const p = await mgmt(ctx, "GET", `/projects/${LEGACY_REF}`);
            const json = p.json as { status?: string } | undefined;
            if (json?.status === "INACTIVE") {
              repauseS = Math.round((Date.now() - t0) / 1000);
              break;
            }
          }
          i03bResult = {
            id: "I03b",
            title: "I03b: pause and check status",
            status: "info",
            measurements: {
              pause_status: pauseStatus,
              repause_s: repauseS,
            },
          };
        } else {
          pauseEvidence = pause.text.slice(0, 300);
          i03bResult = {
            id: "I03b",
            title: "I03b: pause and check status",
            status: "info",
            measurements: { pause_status: pauseStatus },
            evidence: pauseEvidence,
          };
        }
      } else {
        i03bResult = {
          id: "I03b",
          title: "I03b: pause and check status",
          status: "info",
          measurements: { pause_status: 0 },
          detail: "I03a failed to reach ACTIVE_HEALTHY",
        };
      }
      results.push(i03bResult);

    } catch (e) {
      // In case of unexpected error in the module itself
      results.push({
        id: "I03-error",
        title: "I03: unexpected error",
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    return results;
  },
};

export default mod;
