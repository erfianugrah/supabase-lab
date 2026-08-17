/**
 * X03 - testing refresh token behavior when presented to a different issuer.
 *
 * The claim: after a hub project's GoTrue is registered as a trusted third-party issuer on a spoke project,
 * a REFRESH token minted by the hub still only works at the HUB - the spoke can verify access
 * tokens but cannot mint or refresh sessions. Presenting the hub's refresh token
 * to the spoke's `/auth/v1/token?grant_type=refresh_token` is expected to answer
 * 400 `refresh_token_not_found`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

async function getKeys(ctx: Ctx, ref: string) {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
  const arr = Array.isArray(r.json) ? (r.json as any[]) : [];
  const findKey = (pattern: string) => arr.find((k) => k.name === pattern || k.type === pattern)?.api_key;
  return {
    anon: findKey("anon"),
    service: findKey("service_role"),
  };
}

const mod: TestModule = {
  id: "X03",
  title: "Cross-project auth: refresh token issuer verification",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const hub = ctx.ref;
    const spoke = ctx.peers.spoke;
    if (!spoke) {
      return {
        id: "X03",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_SPOKE not set",
      };
    }

    const failBoth = (detail: string): TestResult[] => [
      { id: "X03-control", title: "Hub accepts its own refresh token", status: "fail", detail },
      { id: "X03a", title: "Spoke refuses hub refresh token", status: "fail", detail },
    ];

    const hubKeys = await getKeys(ctx, hub);
    const spokeKeys = await getKeys(ctx, spoke);
    if (!hubKeys.anon || !hubKeys.service || !spokeKeys.anon) {
      return failBoth("setup: could not read project API keys");
    }

    const hAnon = hubKeys.anon!;
    const hService = hubKeys.service!;
    const sAnon = spokeKeys.anon!;

    const results: TestResult[] = [];

    // Setup: create user on hub with retry for 500
    const email = `test-${Math.random().toString(36).slice(2)}@lab.invalid`;
    let userCreated = false;
    for (let i = 0; i < 5; i++) {
      try {
        const res = await fetch(`https://${hub}.supabase.co/auth/v1/admin/users`, {
          method: "POST",
          headers: {
            apikey: hService,
            Authorization: `Bearer ${hService}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email,
            password: "LabPassword123!",
            email_confirm: true,
          }),
        });
        if (res.ok) {
          userCreated = true;
          break;
        }
        ctx.log(`User creation attempt ${i + 1} failed: ${res.status}`);
      } catch (e) {
        ctx.log(`User creation attempt ${i + 1} error: ${e}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!userCreated) {
      return failBoth("setup: could not create admin user on hub after retries");
    }

    // Login twice on hub to get two sessions A and B
    const login = async () => {
      try {
        const res = await fetch(`https://${hub}.supabase.co/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: hAnon, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "LabPassword123!" }),
        });
        if (!res.ok) return null;
        const j = (await res.json()) as any;
        return j.refresh_token;
      } catch {
        return null;
      }
    };

    const tokA = await login();
    const tokB = await login();
    if (!tokA || !tokB) {
      return failBoth("setup: could not obtain hub login sessions");
    }

    // X03a: Present A to Spoke
    let resA: Response | null = null;
    try {
      resA = await fetch(`https://${spoke}.supabase.co/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: sAnon, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokA }),
      });
    } catch (e) {
      ctx.log(`X03a fetch error: ${e}`);
    }

    if (!resA) {
      results.push({ id: "X03a", title: "spoke probe", status: "fail", detail: "fetch failed" });
    } else {
      const status = resA.status;
      const text = await resA.text();
      let code = "none";
      try {
        const j = JSON.parse(text);
        code = j.error_code || j.error || j.code || "none";
      } catch {}
      results.push({
        id: "X03a",
        title: "Spoke refuses hub refresh token",
        status: "info",
        measurements: { spoke_status: status, error_code: code },
        // Evidence only on non-2xx: error bodies carry no tokens. A 2xx body
        // would contain FRESH (rotated) access/refresh tokens, and redacting
        // the originals does not catch those - so success bodies are never
        // recorded at all.
        evidence: status === 200 ? undefined : text.slice(0, 300),
      });
    }

    // X03-control: Present B to Hub
    let resB: Response | null = null;
    try {
      resB = await fetch(`https://${hub}.supabase.co/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: hAnon, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokB }),
      });
    } catch (e) {
      ctx.log(`X03-control fetch error: ${e}`);
    }

    if (!resB) {
      results.push({ id: "X03-control", title: "hub control", status: "fail", detail: "fetch failed" });
    } else {
      const status = resB.status;
      const text = await resB.text();
      results.push({
        id: "X03-control",
        title: "Hub accepts its own refresh token",
        status: status === 200 ? "pass" : "fail",
        // Same rule as X03a: never record a success body (it carries tokens).
        evidence: status === 200 ? undefined : text.slice(0, 300),
      });
    }

    return results;
  },
};
export default mod;
