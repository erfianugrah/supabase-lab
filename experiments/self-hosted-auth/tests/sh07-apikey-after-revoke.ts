/**
 * SH07 - the legacy anon apikey after the HS256 key is revoked: value match
 * or cache window.
 *
 * SH06f saw the legacy anon JWT still accepted in the `apikey` header 10 s
 * after the HS256 signing key was revoked, while as a BEARER it had failed
 * within 4 s in SH05. Two readings: the API gateway in front of PostgREST
 * accepts that apikey on something the revoke does not change (the key's
 * value, or a signature check against a key set that still holds the revoked
 * key) and PostgREST verifies only the bearer; or a gateway cache that had not
 * expired (the legacy-key disable took ~45 s in iap-lockdown L05).
 *
 * The bearer here is a managed ES256 user token, so PostgREST accepts it
 * regardless of the HS256 key, and only the apikey varies:
 *
 *   A  legacy anon apikey (revoked key)  + ES256 bearer   <- the subject
 *   F  anon claims re-signed under a random secret + ES256 bearer
 *      (a JWT the platform never issued: does the gateway check JWT apikeys
 *      at all, or does anything JWT-shaped pass when a bearer is present?)
 *   V  anon claims with iat+1, signed under the project's own legacy secret
 *      (GET /postgrest jwt_secret) + ES256 bearer: a validly signed key whose
 *      string the platform never issued - value match refuses it, a signature
 *      check accepts it
 *   P  sb_publishable apikey + ES256 bearer               (positive control)
 *   S  legacy service_role apikey + ES256 bearer
 *   K  no apikey, ES256 bearer only                        (gateway control)
 *   N  legacy anon as apikey AND bearer                    (the SH05 shape)
 *   H  legacy anon apikey on /auth/v1/health (SH05d saw 200 after the revoke)
 *
 *   SH07a  self-provisioned project, signing keys, user, bearer shape
 *   SH07b  the set before the revoke
 *   SH07c  PATCH the HS256 key to revoked
 *   SH07d  the set at 10, 30, 45, 60, 120, 300, 600 s after the revoke
 *   SH07e  POST /restart (confirmed by pg_postmaster_start_time), wait for
 *          the Data API, the set again
 *   SH07f  the reading per variant across the ladder
 *
 * A flipping to refused at a fixed delay = cache window. A at 200 through
 * 600 s and after the restart, with F refused, = the gateway accepts the
 * revoked anon key on something the revoke did not change. F (issued header
 * and claims, foreign signature) refused rules out a claims-only check. V
 * refused = the gateway accepts only the issued key: a valid signature is not
 * enough; whether it compares the whole string or checks the claims plus the
 * signature is not separated by these variants. V accepted = any JWT validly
 * signed under the legacy secret passes (the revoke does not change the
 * secret). F at 200 = the gateway does not check a JWT apikey when a bearer
 * is present. V is only meaningful if the `GET /postgrest` jwt_secret is the
 * anon key's signing secret: SH07a checks that re-signing the anon key with
 * it, claims unchanged, reproduces the anon key byte for byte.
 *
 * DESTRUCTIVE and self-provisioning: creates one project in ctx.orgs.pro,
 * revokes its HS256 key (irreversible), deletes the project in `finally`.
 * Run with `--only SH07`; n is the number of separate runs.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  adminCreate,
  codeOf,
  ensureProbeTable,
  fetchKeys,
  http,
  jwtShape,
  type Mark,
  managedAuth,
  passwordGrant,
  PROBE_TABLE,
  type Probe,
  randomEmail,
  randomPassword,
  refusedBy,
  resignHs256,
  sql,
  transition,
} from "../lib/sha";

const REGION = "ap-southeast-1";
const LADDER_S = [10, 30, 45, 60, 120, 300, 600];
const VARIANTS = ["A", "F", "V", "P", "S", "K", "N", "H"] as const;
type Variant = (typeof VARIANTS)[number];

interface KeyRow {
  id?: string;
  algorithm?: string;
  status?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function retryMgmt(ctx: Ctx, method: string, path: string, body?: unknown) {
  let r = await mgmt(ctx, method, path, body);
  for (let i = 0; i < 6 && (r.throttled || r.status === 429); i++) {
    await sleep(15_000);
    r = await mgmt(ctx, method, path, body);
  }
  return r;
}

/** One cell: status, refusing layer, the platform's label verbatim. */
function cell(p: Probe): { status: number; by: string; label: string } {
  return { status: p.status, by: refusedBy(p) || "none", label: p.status >= 300 ? (codeOf(p) || p.text.slice(0, 80)) : "" };
}

const mod: TestModule = {
  id: "SH07",
  title: "Legacy anon apikey after the HS256 revoke: value match or cache window",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "SH07", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    try {
      // SH07a - provision.
      const t0 = Date.now();
      const create = await retryMgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `sha-sh07-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
        desired_instance_size: "micro",
      });
      ref = String((create.json as { ref?: string } | undefined)?.ref ?? "");
      if (!ref) {
        out.push({ id: "SH07a", title: "provision", status: "fail", detail: `create HTTP ${create.status} ${create.text.slice(0, 200)}` });
        return out;
      }
      ctx.log(`SH07 project created (${Math.round((Date.now() - t0) / 1000)} s)`);
      const pc: Ctx = { ...ctx, ref, apiHost: `${ref}.${ctx.apiHostSuffix ?? "supabase.co"}` };
      let status = "";
      for (let i = 0; i < 120 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        status = String(((await retryMgmt(pc, "GET", `/projects/${ref}`)).json as { status?: string } | undefined)?.status ?? "");
      }
      let keys = await fetchKeys(pc).catch(() => undefined);
      for (let i = 0; i < 30 && !keys?.publishable; i++) {
        await sleep(10_000);
        keys = await fetchKeys(pc).catch(() => undefined);
      }
      if (status !== "ACTIVE_HEALTHY" || !keys?.publishable) {
        out.push({ id: "SH07a", title: "provision", status: "fail", detail: `status ${status}; keys ${keys ? "no publishable" : "absent"}` });
        return out;
      }
      const M = managedAuth(pc);
      for (let i = 0; i < 30; i++) {
        if ((await http(`${M}/health`, { key: keys.anon })).status === 200) break;
        await sleep(10_000);
      }
      const list = await retryMgmt(pc, "GET", `/projects/${ref}/config/auth/signing-keys`);
      const rows = ((list.json as { keys?: KeyRow[] } | undefined)?.keys ?? []) as KeyRow[];
      const hs = rows.find((k) => k.algorithm === "HS256");
      // A project minutes old can be ACTIVE_HEALTHY with keys and Auth up
      // while the query endpoint still answers 28P01 for `postgres`
      // ("If you recently created this project, wait a moment") - first
      // SH07 attempt, 2026-10-23, ~30 s after create.
      for (let i = 0; ; i++) {
        try {
          await ensureProbeTable(pc);
          break;
        } catch (e) {
          if (i >= 30) throw e;
          await sleep(10_000);
        }
      }
      ctx.log(`SH07 ref ${ref} ready`);
      const email = randomEmail("sh07");
      const password = randomPassword();
      const user = await adminCreate(M, keys, email, password);
      const grant = await passwordGrant(M, keys, email, password);
      const shape = jwtShape(grant.accessToken);
      const bearer = grant.accessToken;
      const forged = resignHs256(keys.anon, crypto.randomUUID());
      const pg = await retryMgmt(pc, "GET", `/projects/${ref}/postgrest`);
      const secret = String((pg.json as { jwt_secret?: string } | undefined)?.jwt_secret ?? "");
      if (!secret) throw new Error(`no jwt_secret from GET /postgrest (HTTP ${pg.status})`);
      const anonIat = Number((JSON.parse(Buffer.from(keys.anon.split(".")[1] ?? "", "base64url").toString("utf8")) as { iat?: number }).iat ?? 0);
      const reminted = resignHs256(keys.anon, secret, { iat: anonIat + 1 });
      // V rests on this: the secret must reproduce the issued anon key.
      const secretOk = resignHs256(keys.anon, secret) === keys.anon;
      const rest = `https://${pc.apiHost}/rest/v1/${PROBE_TABLE}?select=id`;
      const probeSet = async (): Promise<Record<Variant, Probe>> => {
        const noKey = async (): Promise<Probe> => {
          const t = performance.now();
          try {
            const r = await fetch(rest, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(20_000) });
            const text = await r.text();
            let json: Record<string, unknown> = {};
            try {
              json = JSON.parse(text) as Record<string, unknown>;
            } catch {
              /* non-JSON */
            }
            return { status: r.status, json, text, ms: Math.round(performance.now() - t) };
          } catch (e) {
            return { status: 0, json: {}, text: `ERR:${e instanceof Error ? e.message : String(e)}`, ms: Math.round(performance.now() - t) };
          }
        };
        const [A, F, V, P, S, K, N, H] = await Promise.all([
          http(rest, { key: keys!.anon, bearer }),
          http(rest, { key: forged, bearer }),
          http(rest, { key: reminted, bearer }),
          http(rest, { key: keys!.publishable!, bearer }),
          http(rest, { key: keys!.service, bearer }),
          noKey(),
          http(rest, { key: keys!.anon }),
          http(`${M}/health`, { key: keys!.anon }),
        ]);
        return { A: A!, F: F!, V: V!, P: P!, S: S!, K: K!, N: N!, H: H! };
      };
      const asMeasurements = (set: Record<Variant, Probe>) => {
        const m: Record<string, string | number> = {};
        for (const v of VARIANTS) {
          const c = cell(set[v]);
          m[`${v}_status`] = c.status;
          m[`${v}_by`] = c.by;
          if (c.label) m[`${v}_label`] = c.label;
        }
        return m;
      };
      const line = (set: Record<Variant, Probe>) => VARIANTS.map((v) => `${v}=${set[v].status}${set[v].status >= 300 ? `(${refusedBy(set[v]) || "?"})` : ""}`).join(" ");

      out.push({
        id: "SH07a",
        title: "self-provisioned project: signing keys, user, bearer shape",
        status: hs?.status === "previously_used" && grant.status === 200 && shape?.alg === "ES256" && secretOk ? "pass" : "fail",
        detail: `ready after ${Math.round((Date.now() - t0) / 1000)} s; signing keys ${rows.map((k) => `${k.algorithm}:${k.status}`).join(", ")}; user create ${user.status}; managed grant ${grant.status} alg ${shape?.alg ?? "?"}; GET /postgrest jwt_secret reproduces the anon key: ${secretOk ? "yes" : "NO"}`,
        measurements: {
          ready_s: Math.round((Date.now() - t0) / 1000),
          signing_keys: rows.map((k) => `${k.algorithm}:${k.status}`).join(","),
          hs256_status: hs?.status ?? "absent",
          user_create_status: user.status,
          grant_status: grant.status,
          bearer_alg: shape?.alg ?? "?",
          bearer_has_kid: shape?.kid ? "yes" : "no",
          secret_reproduces_anon: secretOk ? "yes" : "no",
        },
      });
      if (hs?.status !== "previously_used" || !hs.id || shape?.alg !== "ES256") return out;

      // SH07b - before.
      const before = await probeSet();
      out.push({ id: "SH07b", title: "before the revoke", status: "info", detail: line(before), measurements: asMeasurements(before) });

      // SH07c - revoke.
      const rev = await retryMgmt(pc, "PATCH", `/projects/${ref}/config/auth/signing-keys/${hs.id}`, { status: "revoked" });
      const tRev = Date.now();
      out.push({
        id: "SH07c",
        title: "PATCH the HS256 key to revoked",
        status: rev.status < 300 ? "pass" : "fail",
        detail: `HTTP ${rev.status}; key status ${String((rev.json as KeyRow | undefined)?.status ?? "?")}`,
        measurements: { status: rev.status, key_status_after: String((rev.json as KeyRow | undefined)?.status ?? "?") },
        evidence: rev.status >= 300 ? rev.text.slice(0, 300) : undefined,
      });
      if (rev.status >= 300) return out;

      // SH07d - the ladder.
      const series: Record<Variant, Mark[]> = { A: [], F: [], V: [], P: [], S: [], K: [], N: [], H: [] };
      for (const mark of LADDER_S) {
        const wait = tRev + mark * 1000 - Date.now();
        if (wait > 0) await sleep(wait);
        const actual = Math.round((Date.now() - tRev) / 1000);
        const set = await probeSet();
        for (const v of VARIANTS) series[v].push({ t: mark, status: set[v].status });
        out.push({
          id: `SH07d-${mark}s`,
          title: `${mark} s after the revoke`,
          status: "info",
          detail: `t=${actual}s ${line(set)}`,
          measurements: { t_s: actual, ...asMeasurements(set) },
        });
        ctx.log(`SH07 +${actual}s ${line(set)}`);
      }

      // SH07e - restart the project, then the set again.
      const pmBefore = String((await sql(pc, "select pg_postmaster_start_time()::text as t")).rows[0]?.t ?? "");
      const rs = await retryMgmt(pc, "POST", `/projects/${ref}/restart`);
      const tRs = Date.now();
      await sleep(30_000);
      let pmAfter = pmBefore;
      let healthy = "";
      let pubOk = false;
      while (Date.now() - tRs < 15 * 60_000) {
        healthy = String(((await retryMgmt(pc, "GET", `/projects/${ref}`)).json as { status?: string } | undefined)?.status ?? "");
        pubOk = (await http(rest, { key: keys.publishable!, bearer })).status === 200;
        if (healthy === "ACTIVE_HEALTHY" && pubOk) {
          pmAfter = String((await sql(pc, "select pg_postmaster_start_time()::text as t")).rows[0]?.t ?? pmBefore);
          if (pmAfter !== pmBefore) break;
        }
        await sleep(10_000);
      }
      const restartS = Math.round((Date.now() - tRs) / 1000);
      const after = await probeSet();
      const sinceRevoke = Math.round((Date.now() - tRev) / 1000);
      out.push({
        id: "SH07e",
        title: "after POST /restart",
        status: rs.status < 300 && pmAfter !== pmBefore ? "info" : "fail",
        detail: `restart HTTP ${rs.status}; postmaster restarted ${pmAfter !== pmBefore ? "yes" : "NO"}; data API back after ${restartS} s; t=${sinceRevoke}s since revoke; ${line(after)}`,
        measurements: { restart_status: rs.status, postmaster_restarted: pmAfter !== pmBefore ? "yes" : "no", restart_to_ready_s: restartS, t_s: sinceRevoke, ...asMeasurements(after) },
      });
      for (const v of VARIANTS) series[v].push({ t: sinceRevoke, status: after[v].status });

      // SH07f - the reading.
      const read: Record<string, string | number> = {};
      for (const v of VARIANTS) read[v] = transition(series[v]).label;
      const a = transition(series.A);
      const verdict =
        series.F.every((m) => m.status === 200)
          ? "F (never-issued JWT) passes too: the gateway does not check a JWT apikey when a bearer is present"
          : a.flipAt !== null
            ? `A refused from ${a.flipAt} s: a propagation window, not a value match`
            : a.label === "200 throughout"
              ? `A accepted through the ladder and after the restart while F is refused; V (validly signed, never issued) ${transition(series.V).label}: ` +
                (!secretOk
                  ? "V is not validly signed (the secret check failed), so it says nothing"
                  : series.V.every((m) => m.status === 200)
                    ? "any JWT validly signed under the legacy secret passes the gateway, and the revoke does not change the secret"
                    : series.V.every((m) => m.status !== 200)
                      ? "the gateway accepts only the issued key - a valid signature is not enough (V) and the issued claims with another signature are refused (F); whole-string match vs claims plus signature not separated"
                      : "mixed - read the per-mark rows")
              : `A ${a.label}`;
      out.push({ id: "SH07f", title: "reading across the ladder", status: "info", detail: verdict, measurements: read });
    } catch (e) {
      out.push({ id: "SH07", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (ref) {
        let st = 0;
        for (let i = 0; i < 6; i++) {
          const r = await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => ({ status: 0, throttled: false }));
          st = r.status;
          if ((st >= 200 && st < 300) || st === 404) break;
          await sleep(r.throttled || st === 429 ? 15_000 : 5_000);
        }
        out.push({ id: "SH07z", title: "cleanup: delete the project", status: (st >= 200 && st < 300) || st === 404 ? "pass" : "fail", detail: `DELETE HTTP ${st}` });
      }
    }
    return out;
  },
};
export default mod;
