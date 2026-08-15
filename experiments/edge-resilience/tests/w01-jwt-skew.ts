/**
 * W01 - JWT issued-at skew map (the PGRST303 incident class).
 *
 * Maps the actual iat tolerance PostgREST enforces vs the documented 30s.
 * Destructive: registers and deletes a third-party-auth integration.
 */
import { generateKeyPairSync } from "node:crypto";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { mintEs256 } from "../lib/jwt";

/** base64url-encode a buffer without padding. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const mod: TestModule = {
  id: "W01",
  title: "JWT issued-at skew map",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,

  async run(ctx): Promise<TestResult> {
    const id = "W01";
    const title = this.title;

    const edgeUrl = ctx.endpoints["edge_url"];
    const jwksPriv = ctx.endpoints["jwks_priv"];

    if (!edgeUrl || !jwksPriv) {
      return {
        id,
        title,
        status: "skip",
        detail: `Missing endpoints: edge_url=${edgeUrl ?? "(absent)"}, jwks_priv=${jwksPriv ?? "(absent)"}`,
      };
    }

    ctx.log(`edge_url: ${edgeUrl}, jwks_priv: ${jwksPriv}`);

    const probeUrl = `https://${ctx.apiHost}/rest/v1/w_probe?select=id`;
    const tpaPath = `/projects/${ctx.ref}/config/auth/third-party-auth`;

    /** GET the probe table with a bearer token. Returns status + PGREST code. */
    const fetchProbe = async (
      token: string,
    ): Promise<{ status: number; code: string | undefined }> => {
      const res = await fetch(probeUrl, {
        headers: {
          apikey: ctx.anonKey!,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let code: string | undefined;
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        if (typeof j.code === "string") code = j.code;
      } catch {
        // non-JSON body
      }
      return { status: res.status, code };
    };

    const listTpa = async (): Promise<Record<string, unknown>[]> => {
      const r = await mgmt(ctx, "GET", tpaPath);
      return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
    };

    const clearTpa = async (): Promise<void> => {
      for (const t of await listTpa()) {
        if (typeof t.id === "string") {
          await mgmt(ctx, "DELETE", `${tpaPath}/${t.id}`);
        }
      }
    };

    const awaitResolution = async (
      integrationId: string,
      budgetMs: number,
    ): Promise<{ resolved: boolean; ms: number; row: Record<string, unknown> | undefined }> => {
      const t0 = performance.now();
      let last: Record<string, unknown> | undefined;
      while (performance.now() - t0 < budgetMs) {
        const found = (await listTpa()).find((t) => t.id === integrationId);
        last = found;
        if (found?.resolved_jwks != null || found?.resolved_at != null) {
          return { resolved: true, ms: Math.round(performance.now() - t0), row: found };
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      return { resolved: false, ms: Math.round(performance.now() - t0), row: last };
    };

    /**
     * Mint a token signed with a freshly generated EC P-256 keypair that is
     * NOT registered with the project - expects PGRST301.
     */
    const mintWrongKey = (claims: object): string => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const header = { alg: "ES256", typ: "JWT", kid: "wrong-key-unknown" };
      const encHeader = b64url(Buffer.from(JSON.stringify(header)));
      const encPayload = b64url(Buffer.from(JSON.stringify(claims)));
      const { createSign } = require("node:crypto") as typeof import("node:crypto");
      const sig = createSign("sha256")
        .update(Buffer.from(`${encHeader}.${encPayload}`))
        .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
      return `${encHeader}.${encPayload}.${b64url(sig)}`;
    };

    // Collect per-probe evidence to surface in the artifact regardless of outcome.
    const evidence: string[] = [];

    let tpaId: string | undefined;

    try {
      // Step 2: register TPA.
      const reg = await mgmt(ctx, "POST", tpaPath, { jwks_url: `${edgeUrl}/jwks.json` });
      if (reg.status >= 300 || typeof (reg.json as Record<string, unknown>)?.id !== "string") {
        return {
          id,
          title,
          status: "fail",
          detail: `TPA register failed: HTTP ${reg.status}`,
          evidence: reg.text.slice(0, 400),
        };
      }
      tpaId = (reg.json as Record<string, unknown>).id as string;
      evidence.push(`TPA id=${tpaId}, create_status=${reg.status}`);

      const resolution = await awaitResolution(tpaId, 120_000);
      evidence.push(`resolved=${resolution.resolved}, resolve_ms=${resolution.ms}`);
      if (!resolution.resolved) {
        return {
          id,
          title,
          status: "fail",
          detail: `TPA never resolved after ${resolution.ms}ms - tokens will fail with PGRST301`,
          measurements: {
            tpa_id: tpaId,
            resolved: "false",
            resolve_ms: resolution.ms,
          },
          evidence: JSON.stringify(resolution.row ?? {}).slice(0, 400),
        };
      }

      // Warm-up: the Management API "resolved" flag precedes PostgREST actually
      // loading the JWKS into its cache. In the prior run, offsets 0 and 15 got
      // PGRST301 (key not found) while offset 30 got 200 - ~30s lag. Poll with
      // iat=now until we get 200 (key loaded) before starting the matrix, so
      // every offset in the matrix is measured against a warm cache.
      const warmupBudgetMs = 120_000;
      const warmupT0 = performance.now();
      let warmupAttempts = 0;
      let warmupFinalStatus = -1;
      let warmupFinalCode: string | undefined;
      while (performance.now() - warmupT0 < warmupBudgetMs) {
        warmupAttempts++;
        const wNow = Math.floor(Date.now() / 1000);
        const warmupToken = await mintEs256(jwksPriv, {
          role: "authenticated",
          aud: "authenticated",
          sub: "00000000-0000-0000-0000-000000000001",
          iat: wNow,
          exp: wNow + 3600,
        });
        const warmupProbe = await fetchProbe(warmupToken);
        warmupFinalStatus = warmupProbe.status;
        warmupFinalCode = warmupProbe.code;
        evidence.push(
          `warmup attempt ${warmupAttempts}: HTTP ${warmupProbe.status}${warmupProbe.code ? ` ${warmupProbe.code}` : ""}`,
        );
        if (warmupProbe.status === 200) {
          // Key is loaded and a valid iat=now token is accepted.
          break;
        }
        if (warmupProbe.status === 401 && warmupProbe.code !== "PGRST301") {
          // Key loaded (PGRST303 = iat too far in future; should not happen for
          // iat=now, but if it does the key IS loaded - proceed).
          break;
        }
        // PGRST301 = kid not found yet; wait and retry.
        await new Promise((r) => setTimeout(r, 3_000));
      }

      const measurements: Record<string, number | string> = {
        warmup_attempts: warmupAttempts,
        warmup_final_status: warmupFinalStatus,
      };
      if (warmupFinalCode) measurements["warmup_final_code"] = warmupFinalCode;

      if (warmupFinalStatus !== 200) {
        return {
          id,
          title,
          status: "fail",
          detail: `PostgREST did not load JWKS within warmup budget (${Math.round((performance.now() - warmupT0) / 1000)}s); last HTTP ${warmupFinalStatus}${warmupFinalCode ? ` ${warmupFinalCode}` : ""}`,
          measurements,
          evidence: evidence.join("\n"),
        };
      }

      // Step 4: probe matrix - use fresh now so offsets are accurate after warm-up.
      const offsets = [-3600, 0, 15, 30, 31, 60, 300, 3600] as const;
      const now = Math.floor(Date.now() / 1000);

      let max200 = Number.NEGATIVE_INFINITY;
      let min401 = Number.POSITIVE_INFINITY;
      let offset0Status = -1;
      let offset3600Status = -1;
      let offset3600Code: string | undefined;

      for (const offset of offsets) {
        const claims = {
          role: "authenticated",
          aud: "authenticated",
          sub: "00000000-0000-0000-0000-000000000001",
          iat: now + offset,
          exp: now + offset + 3600,
        };
        const token = await mintEs256(jwksPriv, claims);
        const probe = await fetchProbe(token);

        measurements[`offset_${offset}_status`] = probe.status;
        if (probe.code) measurements[`offset_${offset}_code`] = probe.code;
        evidence.push(`offset=${offset}: HTTP ${probe.status}${probe.code ? ` ${probe.code}` : ""}`);

        if (probe.status === 200) {
          if (offset > max200) max200 = offset;
        } else if (probe.status === 401) {
          if (offset < min401) min401 = offset;
        }
        if (offset === 0) offset0Status = probe.status;
        if (offset === 3600) {
          offset3600Status = probe.status;
          offset3600Code = probe.code;
        }
      }

      if (max200 > Number.NEGATIVE_INFINITY) measurements["max_offset_200"] = max200;
      if (min401 < Number.POSITIVE_INFINITY) measurements["min_offset_401"] = min401;

      // Step 4 controls.
      const expiredClaims = {
        role: "authenticated",
        aud: "authenticated",
        sub: "00000000-0000-0000-0000-000000000001",
        iat: now - 7200,
        exp: now - 3600,
      };
      const expiredToken = await mintEs256(jwksPriv, expiredClaims);
      const expiredProbe = await fetchProbe(expiredToken);
      measurements["ctrl_expired_status"] = expiredProbe.status;
      if (expiredProbe.code) measurements["ctrl_expired_code"] = expiredProbe.code;
      evidence.push(
        `ctrl_expired: HTTP ${expiredProbe.status}${expiredProbe.code ? ` ${expiredProbe.code}` : ""}`,
      );

      const wrongKeyClaims = {
        role: "authenticated",
        aud: "authenticated",
        sub: "00000000-0000-0000-0000-000000000001",
        iat: now,
        exp: now + 3600,
      };
      const wrongKeyToken = mintWrongKey(wrongKeyClaims);
      const wrongKeyProbe = await fetchProbe(wrongKeyToken);
      measurements["ctrl_wrongkey_status"] = wrongKeyProbe.status;
      if (wrongKeyProbe.code) measurements["ctrl_wrongkey_code"] = wrongKeyProbe.code;
      evidence.push(
        `ctrl_wrongkey: HTTP ${wrongKeyProbe.status}${wrongKeyProbe.code ? ` ${wrongKeyProbe.code}` : ""}`,
      );

      // Step 5: attribution control - delete TPA and poll until offset-0 stops
      // working. PostgREST evicts its JWKS cache after re-reading config;
      // probing once immediately returns 200 because the cache is still warm.
      // Poll until 401 (cache evicted) or budget is exceeded.
      await clearTpa();
      tpaId = undefined; // cleared; finally need not re-delete

      const attrBudgetMs = 120_000;
      const attrT0 = performance.now();
      let attrAttempts = 0;
      let attrFinalStatus = -1;
      let attrFinalCode: string | undefined;
      {
        // Mint the token once; it stays valid for the poll window (exp = now + 3600).
        const attrNow = Math.floor(Date.now() / 1000);
        const attrToken = await mintEs256(jwksPriv, {
          role: "authenticated",
          aud: "authenticated",
          sub: "00000000-0000-0000-0000-000000000001",
          iat: attrNow,
          exp: attrNow + 3600,
        });
        while (performance.now() - attrT0 < attrBudgetMs) {
          attrAttempts++;
          const attrProbe = await fetchProbe(attrToken);
          attrFinalStatus = attrProbe.status;
          attrFinalCode = attrProbe.code;
          evidence.push(
            `attr attempt ${attrAttempts}: HTTP ${attrProbe.status}${attrProbe.code ? ` ${attrProbe.code}` : ""}`,
          );
          if (attrProbe.status === 401) break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
      measurements["ctrl_attr_status"] = attrFinalStatus;
      if (attrFinalCode) measurements["ctrl_attr_code"] = attrFinalCode;
      measurements["ctrl_attr_attempts"] = attrAttempts;
      evidence.push(
        `ctrl_attr (post-delete, ${attrAttempts} attempts): HTTP ${attrFinalStatus}${attrFinalCode ? ` ${attrFinalCode}` : ""}`,
      );

      // Pass criteria (all):
      //   offset  0     -> 200
      //   offset  3600  -> 401 PGRST303
      //   expired ctrl  -> 401
      //   wrong-key ctrl-> 401 PGRST301
      //   attr ctrl     -> 401 after deletion
      const crit = {
        offset0_200: offset0Status === 200,
        offset3600_401: offset3600Status === 401 && offset3600Code === "PGRST303",
        expired_401: expiredProbe.status === 401,
        wrongkey_401_pgrst301: wrongKeyProbe.status === 401 && wrongKeyProbe.code === "PGRST301",
        attr_401: attrFinalStatus === 401,
      };

      const allPass = Object.values(crit).every(Boolean);
      const failing = Object.entries(crit)
        .filter(([, v]) => !v)
        .map(([k]) => k);

      const detail = allPass
        ? `boundary: max_200=${max200}s, min_401=${min401}s; all criteria met`
        : `criteria not met: ${failing.join(", ")}`;

      return {
        id,
        title,
        status: allPass ? "pass" : "fail",
        detail,
        measurements,
        evidence: evidence.join("\n"),
      };
    } catch (e: unknown) {
      return {
        id,
        title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        evidence: evidence.join("\n"),
      };
    } finally {
      // Step 6: restoration - always clean up even if a probe throws.
      if (tpaId !== undefined) {
        try {
          await clearTpa();
        } catch {
          // best effort
        }
      }
    }
  },
};

export default mod;
