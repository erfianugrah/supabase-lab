/**
 * S14 - secret_jwt_template role-binding
 *
 * Provision one project:
 *
 *   S14a  control: healthy create.
 *   S14b  mint key: `POST /projects/{ref}/api-keys` with
 *         `{"type":"secret","name":"role_probe","secret_jwt_template":{"role":"authenticated","tenant_id":"probe-tenant"}}`.
 *         Record `key_create_status` (201 = created), and capture the returned
 *         `api_key` (DO NOT write the full key value into results - store only its
 *         `prefix` and `hash`). `info`.
 *   S14c  verify binding: the key is opaque, so exchange it at the data plane -
 *         install a `jwt_probe()` RPC returning `auth.jwt()`, call it with the
 *         minted key as `Authorization: Bearer`, and read the claims PostgREST
 *         actually sees. Record `data_plane_status`, `role_bound` (1|0) and
 *         `tenant_claim_present` (1|0). If the key cannot be exercised, S14c is a
 *         `skip` with that reason.
 *
 * Every project created here is deleted in `finally`. A measured 4xx on any
 * gated surface is data (info), never an exception.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}

async function waitHealthy(ctx: Ctx, ref: string, maxIters = 90): Promise<string> {
  let status = "";
  for (let i = 0; i < maxIters && status !== "ACTIVE_HEALTHY"; i++) {
    await sleep(10_000);
    const p = await mgmt(ctx, "GET", `/projects/${ref}`);
    status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
  }
  return status;
}

const mod: TestModule = {
  id: "S14",
  title: "Secret JWT template role-binding",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    let ref = "";
    const ensure = (id: string) => results.some((r) => r.id === id);

    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `s14-sfp-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region_selection: { type: "smartGroup", code:
          "apac"
        },
      });

      if (create.status !== 201) {
        results.push({
          id: "S14a",
          title: "S14a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
      } else {
        ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
        if (!ref) {
          results.push({
            id: "S14a",
            title: "S14a: control",
            status: "fail",
            detail: `create returned no ref: ${create.text.slice(0, 300)}`,
          });
        } else {
          const status = await waitHealthy(ctx, ref);
          const provisionS = Math.round((Date.now() - t0) / 1000);
          results.push({
            id: "S14a",
            title: "S14a: control",
            status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
            detail: status === "ACTIVE_HEALTHY" ? undefined : `not healthy (status=${status})`,
            measurements: { provision_s: provisionS },
          });

          // --- S14b: mint key ---
          // The create response REDACTS the key value by default (masked with
          // U+00B7 dots, which fetch() rejects as an invalid header value) -
          // ask for the real value with ?reveal=true, and if it still is not
          // clean ASCII, re-fetch the key by id with reveal.
          const keyRes = await mgmt(ctx, "POST", `/projects/${ref}/api-keys?reveal=true`, {
            type: "secret",
            name: "role_probe",
            secret_jwt_template: {
              role: "authenticated",
              tenant_id: "probe-tenant",
            },
          });
          const key_status = keyRes.status;
          const cleanKey = (v: unknown): string | undefined =>
            typeof v === "string" && /^[\x21-\x7e]+$/.test(v.trim()) ? v.trim() : undefined;
          let api_key: string | undefined = cleanKey((keyRes.json as any)?.api_key);
          const key_id = (keyRes.json as any)?.id;
          if (!api_key && key_id) {
            const rev = await mgmt(ctx, "GET", `/projects/${ref}/api-keys/${key_id}?reveal=true`);
            api_key = cleanKey((rev.json as any)?.api_key);
          }
          let key_prefix = "unknown";
          let key_hash = "unknown";

          if (api_key) {
            key_prefix = api_key.substring(0, 8);
            const buf = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(api_key),
            );
            key_hash = [...new Uint8Array(buf)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          }

          results.push({
            id: "S14b",
            title: "S14b: mint key",
            status: "info",
            detail: key_status >= 200 && key_status < 300 ? "KEY_CREATED" : "KEY_REJECTED",
            measurements: {
              key_create_status: key_status,
              key_prefix: key_prefix,
              key_hash: key_hash,
            },
            evidence: key_status >= 200 && key_status < 300 ? `key: ${key_prefix}...` : keyRes.text.slice(0, 300),
          });

          // --- S14c: verify binding via the data plane ---
          // The minted key is OPAQUE (not a self-contained JWT); the template
          // is applied server-side when the key is exchanged. So exchange it:
          // expose auth.jwt() through an RPC and call it with the minted key
          // as bearer. Whatever claims PostgREST reports ARE the exchanged
          // token - role_bound/tenant_claim_present are measured, not assumed.
          const keyIsJwt = typeof api_key === "string" && api_key.split(".").length === 3;
          if (!api_key) {
            results.push({
              id: "S14c",
              title: "S14c: verify binding",
              status: "skip",
              detail: "no key minted - nothing to exchange",
            });
          } else {
            const fn = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
              query:
                "create or replace function public.jwt_probe() returns jsonb " +
                "language sql stable as $$ select coalesce(auth.jwt(), '{}'::jsonb) $$; " +
                "grant execute on function public.jwt_probe() to anon, authenticated; " +
                // PostgREST serves from a schema cache; without the reload the
                // fresh function 404s (PGRST202) for a while.
                "notify pgrst, 'reload schema';",
            });
            // /database/query answers successful statements with 201, not 200.
            if (fn.status < 200 || fn.status >= 300) {
              results.push({
                id: "S14c",
                title: "S14c: verify binding",
                status: "skip",
                detail: `jwt_probe install failed: HTTP ${fn.status}: ${fn.text.slice(0, 200)}`,
              });
            } else {
              const suffix = ctx.apiHostSuffix ?? "supabase.co";
              try {
                // retry PGRST202/404 while the schema-cache reload propagates
                let dp: Response | undefined;
                let dpText = "";
                for (let attempt = 0; attempt < 6; attempt++) {
                  dp = await fetch(`https://${ref}.${suffix}/rest/v1/rpc/jwt_probe`, {
                    method: "POST",
                    headers: {
                      apikey: api_key,
                      Authorization: `Bearer ${api_key}`,
                      "Content-Type": "application/json",
                    },
                    body: "{}",
                    signal: AbortSignal.timeout(30_000),
                  });
                  dpText = await dp.text();
                  if (dp.status !== 404) break;
                  await sleep(5_000);
                }
                if (!dp) throw new Error("no response");
                let claims: Record<string, unknown> = {};
                try {
                  claims = JSON.parse(dpText) as Record<string, unknown>;
                } catch {
                  /* non-JSON is data - claims stay empty */
                }
                const role_bound = claims["role"] === "authenticated" ? 1 : 0;
                const tenant_claim_present = claims["tenant_id"] === "probe-tenant" ? 1 : 0;
                results.push({
                  id: "S14c",
                  title: "S14c: verify binding",
                  status: "info",
                  detail:
                    dp.status >= 200 && dp.status < 300
                      ? `exchanged token claims: role=${String(claims["role"])} tenant_id=${String(claims["tenant_id"])}`
                      : `data-plane exchange refused: HTTP ${dp.status}`,
                  measurements: {
                    key_is_jwt: keyIsJwt ? 1 : 0,
                    data_plane_status: dp.status,
                    role_bound,
                    tenant_claim_present,
                  },
                  evidence: dpText.slice(0, 300),
                });
              } catch (fe) {
                // a thrown fetch (header validation, DNS, timeout) is a
                // recorded outcome, not a module failure
                results.push({
                  id: "S14c",
                  title: "S14c: verify binding",
                  status: "skip",
                  detail: `data-plane fetch threw: ${fe instanceof Error ? fe.message.slice(0, 200) : String(fe)}`,
                });
              }
            }
          }
        }
      }

      for (const id of ["S14a", "S14b", "S14c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "skip", detail: "row never produced" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["S14a", "S14b", "S14c"] as const) {
        if (!ensure(id)) {
          results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
        }
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    return results;
  },
};
export default mod;
