/**
 * SH04 - closing the asymmetry: give the self-hosted GoTrue the platform's
 * public key so it verifies managed tokens too.
 *
 * SH02f showed the self-hosted GoTrue refusing a managed ES256 token: it
 * holds only the HS256 secret. GoTrue takes a JWKS in GOTRUE_JWT_KEYS, and a
 * key whose key_ops is ["verify"] with no private part is verify-only. The
 * Makefile's `make gotrue-up JWKS=1` starts the container with the HS256
 * secret (sign+verify) PLUS the managed project's ES256 public key fetched
 * from /auth/v1/.well-known/jwks.json (verify).
 *
 *   SH04a  what the self-hosted GoTrue advertises at its own
 *          /.well-known/jwks.json (which keys, which ops)
 *   SH04b  managed ES256 token -> self-hosted /user: 200 in JWKS mode is the
 *          point; in plain mode the 403 from SH02f is expected and recorded
 *   SH04c  self-hosted token -> managed /user still 200 (the HS256 side is
 *          unchanged by adding a verify key)
 *
 * Mode comes from PVLAB_ENDPOINT_SELFHOSTED_GOTRUE_MODE ("plain" | "jwks"),
 * which the Makefile exports from how it started the container. DESTRUCTIVE:
 * creates a user (deleted in finally).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  adminCreate,
  adminDelete,
  ensureProbeTable,
  fetchKeys,
  http,
  jwtShape,
  managedAuth,
  passwordGrant,
  randomEmail,
  randomPassword,
  restRead,
  selfHosted,
  whoami,
} from "../lib/sha";

const mod: TestModule = {
  id: "SH04",
  title: "Self-hosted GoTrue verifying the managed key (JWKS mode)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const S = selfHosted(ctx);
    if (!ctx.ref) return [{ id: "SH04", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    if (!S) return [{ id: "SH04", title: this.title, status: "skip", detail: "no self-hosted GoTrue - run `make gotrue-up JWKS=1` first" }];
    const mode = ctx.endpoints["selfhosted_gotrue_mode"] ?? "plain";
    const M = managedAuth(ctx);
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    let userId = "";
    try {
      // SH04a - advertised keys on both sides.
      const selfJwks = await http(`${S}/.well-known/jwks.json`);
      const managedJwks = await http(`${M}/.well-known/jwks.json`, { key: keys.anon });
      const describe = (p: typeof selfJwks) =>
        (Array.isArray(p.json.keys) ? (p.json.keys as { kty?: string; alg?: string; key_ops?: string[]; kid?: string }[]) : [])
          .map((k) => `${k.kty}/${k.alg ?? "?"}:${(k.key_ops ?? []).join("+")}`)
          .join("|") || "none";
      out.push({
        id: "SH04a",
        title: `advertised JWKS (mode=${mode})`,
        status: selfJwks.status === 200 ? "info" : "fail",
        detail: `self-hosted ${selfJwks.status}: ${describe(selfJwks)}; managed ${managedJwks.status}: ${describe(managedJwks)}`,
        measurements: { mode, self_hosted_status: selfJwks.status, self_hosted_keys: describe(selfJwks), managed_keys: describe(managedJwks) },
      });

      const email = randomEmail("sh04");
      const password = randomPassword();
      const created = await adminCreate(M, keys, email, password);
      userId = created.id;
      if (!userId) return [...out, { id: "SH04", title: this.title, status: "fail", detail: `managed admin create ${created.status} ${created.code}` }];
      const managed = await passwordGrant(M, keys, email, password);
      const self = await passwordGrant(S, keys, email, password);

      // SH04b - managed token against self-hosted.
      const b = await whoami(S, keys, managed.accessToken);
      const mAlg = jwtShape(managed.accessToken)?.alg ?? "?";
      out.push({
        id: "SH04b",
        title: "managed token verified by the self-hosted GoTrue",
        status: mode === "jwks" ? (b.status === 200 ? "pass" : "fail") : "info",
        detail:
          b.status === 200
            ? `managed ${mAlg} token -> self-hosted /user 200${mode === "jwks" ? " with the platform's public key supplied as a verify-only JWK" : " (unexpected in plain mode)"}`
            : `managed ${mAlg} token -> self-hosted /user ${b.status} ${b.code}${mode === "plain" ? " - expected: only the HS256 secret is configured" : " - the verify-only key did NOT take"}`,
        measurements: { mode, status: b.status, code: b.code || "none", managed_alg: mAlg },
      });

      // SH04c - self-hosted token against managed GoTrue AND PostgREST. In
      // JWKS mode GoTrue stamps the oct key's kid into the header, and the
      // two managed verifiers treat an unknown kid differently: GoTrue
      // accepted a token with an arbitrary kid, PostgREST answered 401
      // PGRST301. So the kid has to be the platform's HS256 key id, and
      // both verifiers are checked here.
      await ensureProbeTable(ctx);
      await Bun.sleep(3_000);
      const c = await whoami(M, keys, self.accessToken);
      const cRest = await restRead(ctx, keys, self.accessToken);
      const sShape = jwtShape(self.accessToken);
      out.push({
        id: "SH04c",
        title: "self-hosted token still accepted by the managed GoTrue and PostgREST",
        status: c.status === 200 && cRest.status === 200 && cRest.rows === 1 ? "pass" : "fail",
        detail: `self-hosted ${sShape?.alg ?? "?"} token (kid ${sShape?.kid ? sShape.kid.slice(0, 8) : "none"}) -> managed /user ${c.status}${c.code ? ` ${c.code}` : ""}; PostgREST ${cRest.status} rows=${cRest.rows}${cRest.code ? ` ${cRest.code}` : ""}`,
        measurements: {
          user_status: c.status,
          user_code: c.code || "none",
          rest_status: cRest.status,
          rest_rows: cRest.rows,
          rest_code: cRest.code || "none",
          self_alg: sShape?.alg ?? "?",
          self_kid: sShape?.kid ? sShape.kid.slice(0, 8) : "none",
        },
      });
    } catch (e) {
      out.push({ id: "SH04", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (userId) {
        const st = await adminDelete(M, keys, userId).catch(() => 0);
        out.push({ id: "SH04z", title: "cleanup: delete the probe user", status: st < 300 ? "pass" : "fail", detail: `HTTP ${st}`, measurements: { delete_status: st } });
      }
    }
    return out;
  },
};
export default mod;
