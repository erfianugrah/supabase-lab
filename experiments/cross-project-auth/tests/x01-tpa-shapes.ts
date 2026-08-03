/**
 * X01 - which third-party-auth configuration shapes actually resolve.
 *
 * POST /v1/projects/{ref}/config/auth/third-party-auth accepts three shapes:
 * oidc_issuer_url, jwks_url, and custom_jwks. A prior run found custom_jwks
 * accepted with HTTP 201, echoing the key material back intact on a
 * subsequent GET, while resolved_at stayed null and PostgREST rejected every
 * token signed by it. This test records resolution for each shape side by
 * side so the difference is a measurement rather than an anecdote.
 *
 * Resolution is the observable: `resolved_jwks` non-null and `resolved_at`
 * populated. A shape that never resolves is a shape whose tokens will fail at
 * request time with PGRST301, long after the configuration looked correct.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const API = "https://api.supabase.com/v1";

function peerRef(): string | undefined {
  return process.env.XPROJ_SPOKE_REF || undefined;
}

async function mgmt(ctx: Ctx, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.pat}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json: json as Record<string, unknown> | undefined };
}

async function listTpa(ctx: Ctx, ref: string) {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/config/auth/third-party-auth`);
  return Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
}

async function clearTpa(ctx: Ctx, ref: string) {
  for (const t of await listTpa(ctx, ref)) {
    if (typeof t.id === "string") {
      await mgmt(ctx, "DELETE", `/projects/${ref}/config/auth/third-party-auth/${t.id}`);
    }
  }
}

/** Poll resolution, because resolving may not be synchronous with the create. */
async function awaitResolution(ctx: Ctx, ref: string, id: string, budgetMs: number) {
  const t0 = performance.now();
  let last: Record<string, unknown> | undefined;
  while (performance.now() - t0 < budgetMs) {
    const found = (await listTpa(ctx, ref)).find((t) => t.id === id);
    last = found;
    if (found?.resolved_jwks != null || found?.resolved_at != null) {
      return { resolved: true, ms: Math.round(performance.now() - t0), row: found };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { resolved: false, ms: Math.round(performance.now() - t0), row: last };
}

const mod: TestModule = {
  id: "X01",
  title: "Third-party auth: which config shapes resolve",
  where: "local",
  requires: ["pat"],
  destructive: true, // writes and deletes auth config on the spoke
  async run(ctx) {
    const spoke = peerRef();
    if (!spoke) {
      return {
        id: "X01",
        title: this.title,
        status: "skip",
        detail: "XPROJ_SPOKE_REF not set - this experiment needs both projects",
      };
    }
    const results: TestResult[] = [];
    const hubIssuer = `https://${ctx.ref}.supabase.co/auth/v1`;

    // A project's own OIDC discovery document is the input the documented
    // shapes consume, so record that it exists before relying on it.
    const disc = await fetch(`${hubIssuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(15000),
    });
    const discJson = (await disc.json().catch(() => ({}))) as Record<string, unknown>;
    results.push({
      id: "X01a",
      title: "Hub serves an OIDC discovery document",
      status: disc.status === 200 && typeof discJson.jwks_uri === "string" ? "pass" : "fail",
      detail: `issuer=${String(discJson.issuer ?? "none")}`,
      measurements: {
        status: disc.status,
        has_jwks_uri: String(typeof discJson.jwks_uri === "string"),
        grants: Array.isArray(discJson.grant_types_supported)
          ? (discJson.grant_types_supported as string[]).join(",")
          : "none",
      },
      evidence: JSON.stringify(discJson).slice(0, 400),
    });

    const shapes: { name: string; body: Record<string, unknown> }[] = [
      { name: "oidc_issuer_url", body: { oidc_issuer_url: hubIssuer } },
      { name: "jwks_url", body: { jwks_url: `${hubIssuer}/.well-known/jwks.json` } },
      {
        name: "custom_jwks",
        body: {
          custom_jwks: await fetch(`${hubIssuer}/.well-known/jwks.json`)
            .then((r) => r.json())
            .catch(() => ({ keys: [] })),
        },
      },
    ];

    for (const shape of shapes) {
      await clearTpa(ctx, spoke);
      const created = await mgmt(
        ctx,
        "POST",
        `/projects/${spoke}/config/auth/third-party-auth`,
        shape.body,
      );
      const id = typeof created.json?.id === "string" ? created.json.id : undefined;
      if (created.status >= 300 || !id) {
        results.push({
          id: `X01-${shape.name}`,
          title: `${shape.name}: create`,
          status: "fail",
          detail: `create returned HTTP ${created.status}`,
          measurements: { create_status: created.status, resolved: "n/a" },
          evidence: created.text.slice(0, 300),
        });
        continue;
      }
      // 90s is generous: a shape that resolves at all resolved on the create
      // response in prior observation, and the failing shape stayed null for
      // over seven minutes.
      const r = await awaitResolution(ctx, spoke, id, 90000);
      results.push({
        id: `X01-${shape.name}`,
        title: `${shape.name}: resolves`,
        status: r.resolved ? "pass" : "fail",
        detail: r.resolved
          ? `resolved after ${r.ms}ms`
          : `still unresolved after ${r.ms}ms - tokens signed for it will fail with PGRST301`,
        measurements: {
          create_status: created.status,
          resolved: String(r.resolved),
          resolve_ms: r.ms,
          type: String(r.row?.type ?? "unknown"),
        },
        evidence: JSON.stringify(r.row ?? {}).slice(0, 400),
      });
    }

    await clearTpa(ctx, spoke);
    return results;
  },
};
export default mod;
