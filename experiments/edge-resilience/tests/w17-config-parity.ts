/**
 * W17 - auth config parity inventory
 *
 * Checks whether configuration changes on the primary are reflected
 * on the standby and verifies the parity gap created by manual
 * configuration mismatch during a test.
 *
 * Steps:
 * 1. Baseline diff: GET /config/auth on both.
 * 2. Mutation: PATCH primary with distinguishable values.
 * 3. Post-mutation diff: GET /config/auth on both to find the gap.
 * 4. Restore: PATCH primary back to original.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W17",
  title: "auth config parity inventory",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const measurements: Record<string, string | number> = {};
    let originalConfig: Record<string, unknown> | null = null;

    if (!standby) {
      return {
        id: "W17",
        title: this.title,
        status: "skip",
        detail: `missing peer: standby=${standby ?? "absent"}`,
      };
    }

    const cleanup = async () => {
      if (originalConfig) {
        try {
          await mgmt(ctx, "PATCH", `/projects/${primary}/config/auth`, originalConfig);
        } catch (e) {
          // Best effort
        }
      }
    };

    try {
      // 1. GET /config/auth on primary and standby; record baseline diff.
      const pBase = await mgmt(ctx, "GET", `/projects/${primary}/config/auth`);
      const sBase = await mgmt(ctx, "GET", `/projects/${standby}/config/auth`);

      if (pBase.throttled || !pBase.json || sBase.throttled || !sBase.json) {
        throw new Error(`failed to fetch baseline: primary(throttled=${pBase.throttled}), standby(throttled=${sBase.throttled})`);
      }

      const pBaseObj = pBase.json as Record<string, unknown>;
      const sBaseObj = sBase.json as Record<string, unknown>;

      const baselineDiff: Record<string, string> = {};
      const allKeys = new Set([...Object.keys(pBaseObj), ...Object.keys(sBaseObj)]);
      for (const k of allKeys) {
        const vP = pBaseObj[k];
        const vS = sBaseObj[k];
        if (JSON.stringify(vP) !== JSON.stringify(vS)) {
          baselineDiff[k] = `${JSON.stringify(vP)} != ${JSON.stringify(vS)}`;
        }
      }
      measurements["baseline_diff"] = JSON.stringify(baselineDiff);
      originalConfig = { ...pBaseObj };

      // 2. On the primary PATCH distinguishable values: jwt_exp=42200,
      //    uri_allow_list="https://w17.example.com/cb", rate_limit_otp=77.
      //    Wait for readback.
      const patchBody = {
        jwt_exp: 42222,
        uri_allow_list: "https://w17.example.com/cb",
        rate_limit_otp: 77,
      };
      const patchRes = await mgmt(ctx, "PATCH", `/projects/${primary}/config/auth`, patchBody);
      if (patchRes.status >= 300) {
        throw new Error(`PATCH failed: HTTP ${patchRes.status}: ${patchRes.text.slice(0, 300)}`);
      }

      const readbackStart = Date.now();
      let readbackOk = false;
      while (Date.now() - readbackStart < 30000) {
        const r = await mgmt(ctx, "GET", `/projects/${primary}/config/auth`);
        if (r.json && JSON.stringify((r.json as any).jwt_exp) === "42222" &&
            JSON.stringify((r.json as any).uri_allow_list) === '"https://w17.example.com/cb"' &&
            JSON.stringify((r.json as any).rate_limit_otp) === "77") {
          readbackOk = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!readbackOk) throw new Error("PATCH readback failed");
      measurements["patch_readback_ms"] = Date.now() - readbackStart;

      // 3. GET /config/auth on both again; produce the verbatim diff inventory.
      const pAfter = await mgmt(ctx, "GET", `/projects/${primary}/config/auth`);
      const sAfter = await mgmt(ctx, "GET", `/projects/${standby}/config/auth`);

      if (pAfter.throttled || !pAfter.json || sAfter.throttled || !sAfter.json) {
        throw new Error(`failed to fetch post-patch: primary(throttled=${pAfter.throttled}), standby(throttled=${sAfter.throttled})`);
      }

      const pAfterObj = pAfter.json as Record<string, unknown>;
      const sAfterObj = sAfter.json as Record<string, unknown>;

      const postPatchDiff: Record<string, string> = {};
      const allKeysPost = new Set([...Object.keys(pAfterObj), ...Object.keys(sAfterObj)]);
      for (const k of allKeysPost) {
        const vP = pAfterObj[k];
        const vS = sAfterObj[k];
        if (JSON.stringify(vP) != JSON.stringify(vS)) {
          postPatchDiff[k] = `${JSON.stringify(vP)} != ${JSON.stringify(vS)}`;
        }
      }
      measurements["post_patch_diff"] = JSON.stringify(postPatchDiff);

      // 4. Restore the primary's original values; confirm readback.
      await mgmt(ctx, "PATCH", `/projects/${primary}/config/auth`, originalConfig);
      const rRestore = await mgmt(ctx, "GET", `/projects/${primary}/config/auth`);
      if (rRestore.json && JSON.stringify((rRestore.json as any).jwt_exp) !== JSON.stringify(originalConfig.jwt_exp)) {
        throw new Error("Restore failed");
      }
      measurements["restore_success"] = "true";

      return {
        id: "W17",
        title: this.title,
        status: "pass",
        detail: "auth config parity inventory completed",

        measurements,
      };
    } catch (e: any) {
      return {
        id: "W17",
        title: this.title,
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
