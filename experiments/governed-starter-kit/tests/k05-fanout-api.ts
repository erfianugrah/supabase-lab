/**
 * K05 - the fan-out API (backend-for-frontend demo) fans one app request out
 * to four upstream endpoints and degrades instead of failing.
 *
 * Drives the deployed `fanout-api` Edge Function over HTTPS with real user
 * JWTs (password sign-in with the publishable key), against the deployed
 * `upstream-mock` (`make bff-deploy`). The checks themselves are
 * lib/bff-checks.ts, the same ones `make bff-local` runs against a local
 * Docker stack: auth refused without a valid JWT; all upstreams ok; cache
 * hit for the endpoints the upstream marks cacheable; one upstream slow past
 * the per-call timeout -> partial; one failing -> partial; all failing ->
 * 502; a second user never gets the first user's cached data; the cache
 * cannot be written or read as a table through the Data API.
 *
 * Self-skips with a reason when there is no project ref or when fanout-api
 * is not deployed on it (the BFF demo is not part of `make up`).
 *
 * Needs: make bff-deploy, the seed (alice and carol from
 * evidence/users-<ref>.json; override with PVLAB_USERS_FILE).
 */
import { readFileSync } from "node:fs";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { bffChecks, callFanout, type Session } from "../lib/bff-checks";

const REPS = 5;

async function publishableKey(ctx: Ctx): Promise<string> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/api-keys?reveal=true`);
  const keys = (r.json ?? []) as { type?: string; api_key?: string }[];
  const k = keys.find((x) => x.type === "publishable")?.api_key;
  if (!k) throw new Error(`no publishable key (http ${r.status})`);
  return k;
}

async function signIn(ctx: Ctx, pub: string, email: string, password: string): Promise<Session> {
  const r = await fetch(`https://${ctx.apiHost}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in ${email}: http ${r.status}`);
  const j = (await r.json()) as { access_token: string; user: { id: string } };
  return { jwt: j.access_token, id: j.user.id };
}

const mod: TestModule = {
  id: "K05",
  title: "fan-out API (BFF): parallel fan-out to four upstreams, per-call timeout, partial results, per-user cache",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = (detail: string): TestResult[] => [{ id: "K05", title: this.title, status: "skip", detail }];
    if (!ctx.ref) return skip("no project ref (PVLAB_REF) - nothing deployed to test");

    const usersFile = process.env.PVLAB_USERS_FILE ?? `evidence/users-${ctx.ref}.json`;
    let pub: string;
    let a: Session;
    let b: Session;
    try {
      const creds = JSON.parse(readFileSync(usersFile, "utf8")) as Record<string, string>;
      pub = await publishableKey(ctx);
      const pw = (e: string) => {
        const p = creds[e];
        if (!p) throw new Error(`${e} missing from ${usersFile}`);
        return p;
      };
      a = await signIn(ctx, pub, "alice@example.com", pw("alice@example.com"));
      b = await signIn(ctx, pub, "carol@example.com", pw("carol@example.com"));
    } catch (e) {
      return [{ id: "K05", title: this.title, status: "fail", detail: `setup: ${(e as Error).message}` }];
    }

    const target = {
      functionsUrl: `https://${ctx.apiHost}/functions/v1`,
      restUrl: `https://${ctx.apiHost}/rest/v1`,
      publishableKey: pub,
      a,
      b,
      reps: REPS,
    };
    // Not deployed is a skip (the demo is opt-in); deployed but unconfigured is a fail.
    const probe = await callFanout(target, a.jwt, "refresh=1");
    if (probe.status === 404) return skip("fanout-api is not deployed on this project (make bff-deploy)");
    if (probe.status === 503 && probe.body.code === "upstream_not_configured") {
      return [{ id: "K05", title: this.title, status: "fail", detail: "fanout-api deployed but UPSTREAM_BASE_URL / UPSTREAM_API_KEY unset (make bff-deploy sets them)" }];
    }
    ctx.log(`first call http ${probe.status} in ${probe.wall_ms} ms (cold start included)`);

    try {
      const checks = await bffChecks(target);
      return checks.map((c) => ({
        id: `K05.${String(c.n).padStart(2, "0")}`,
        title: c.title,
        status: c.pass ? "pass" : "fail",
        detail: c.detail,
        ...(c.measurements ? { measurements: c.measurements } : {}),
      }));
    } catch (e) {
      return [{ id: "K05", title: this.title, status: "fail", detail: `aborted: ${(e as Error).message}` }];
    }
  },
};

export default mod;
