/**
 * M02 - per-tenant metrics through a scoped credential-proxy gateway.
 *
 * M01 showed a plain PAT can scrape a project's Prometheus metrics endpoint
 * directly - but handing that PAT (or the project's secret key) to every
 * scraper is a god-mode credential. The DIY platform pattern is a
 * credential-proxy gateway that stores the PAT server-side and hands out
 * scoped, revocable keys. This module validates the pattern end to end
 * against the operator's own gateway deployment (a Cloudflare Workers PAT
 * proxy with an IAM-style policy engine, a Supabase request classifier, and
 * a D1 audit log):
 *
 *   M02-control  gateway reachable + admin key valid.
 *   M02a         provision a lab project; register the PAT as a gateway
 *                upstream credential (scope_type "supabase").
 *   M02b         mint a scoped key: allow supabase:metrics:read on
 *                project:<ref> only.
 *   M02c         scrape metrics THROUGH the gateway with the scoped key;
 *                negative controls: an unclassified path and a different
 *                project ref with the same key (deny-by-default and
 *                resource scoping are the headline findings).
 *   M02d         the gateway's audit log shows the proxied calls.
 *
 * Env-gated: without GATEKEEPER_URL / GATEKEEPER_ADMIN_KEY every row
 * self-skips naming the missing variables. The admin key, the PAT, and the
 * minted key secret NEVER appear in results. Cleanup in `finally`: revoke
 * the minted key, delete the upstream token, delete the project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

let PRO_ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run()
const REGION = "ap-southeast-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface KeyCreateResponse {
  result?: { key?: { id?: string } };
}
interface UpstreamCreateResponse {
  result?: { id?: string };
  id?: string;
  warnings?: unknown[];
}
interface AuditEventsResponse {
  result?: Array<{ key_id?: string }>;
}

const mod: TestModule = {
  id: "M02",
  title: "Scoped per-tenant metrics through a credential-proxy gateway",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions+deletes a project; registers+deletes gateway state
  async run(ctx: Ctx): Promise<TestResult[]> {
    PRO_ORG = ctx.orgs.pro ?? "";
    if (!PRO_ORG) return [{ id: "M02", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const gateUrl = process.env.GATEKEEPER_URL;
    const adminKey = process.env.GATEKEEPER_ADMIN_KEY;
    const missing = [
      ...(gateUrl ? [] : ["GATEKEEPER_URL"]),
      ...(adminKey ? [] : ["GATEKEEPER_ADMIN_KEY"]),
    ];
    const titles: Record<string, string> = {
      "M02-control": "M02-control: gateway reachable + admin key valid",
      "M02a": "M02a: provision project + register upstream PAT",
      "M02b": "M02b: mint scoped metrics key",
      "M02c": "M02c: proxied scrape + deny-by-default controls",
      "M02d": "M02d: audit trail",
    };
    if (missing.length > 0) {
      return Object.entries(titles).map(([id, title]) => ({
        id,
        title,
        status: "skip" as const,
        detail: `missing env: ${missing.join(", ")}`,
      }));
    }

    const out = new Map<string, TestResult>();
    const put = (r: TestResult) => out.set(r.id, r);
    const admin = { "X-Admin-Key": adminKey!, "Content-Type": "application/json" };

    let ref = "";
    let upstreamId = "";
    let keyId = "";
    let scopedKey = "";

    try {
      // ---- M02-control ----
      const summary = await fetch(`${gateUrl}/admin/analytics/summary`, {
        headers: admin,
        signal: AbortSignal.timeout(30_000),
      });
      await summary.text();
      put({
        id: "M02-control",
        title: titles["M02-control"]!,
        status: summary.status === 200 ? "pass" : "fail",
        detail: summary.status === 200 ? undefined : `HTTP ${summary.status} - every other row is uninterpretable`,
        measurements: { status: summary.status },
      });
      if (summary.status !== 200) throw new Error("control failed");

      // ---- M02a: provision + register upstream ----
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `m02-gate-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) {
        put({
          id: "M02a",
          title: titles["M02a"]!,
          status: "fail",
          detail: `project create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
        throw new Error("M02a provision failed");
      }
      let status = "";
      for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
      }
      const up = await fetch(`${gateUrl}/admin/upstream-tokens`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          name: `pvlab-m02-${t0}`,
          token: ctx.pat,
          scope_type: "supabase",
          zone_ids: ["*"],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const upText = await up.text();
      let upJson: UpstreamCreateResponse = {};
      try {
        upJson = JSON.parse(upText) as UpstreamCreateResponse;
      } catch {
        upJson = {};
      }
      upstreamId = upJson.result?.id ?? upJson.id ?? "";
      put({
        id: "M02a",
        title: titles["M02a"]!,
        status: "info",
        detail: status !== "ACTIVE_HEALTHY" ? `project not healthy after 15 min (status=${status})` : undefined,
        measurements: {
          provision_s: Math.round((Date.now() - t0) / 1000),
          upstream_status: up.status,
          upstream_warnings: Array.isArray(upJson.warnings) ? upJson.warnings.length : 0,
        },
        // No error-body evidence on gateway calls: a 4xx could echo request
        // material (the request carried the PAT). Statuses suffice.
      });

      // ---- M02b: mint scoped key ----
      const keyRes = await fetch(`${gateUrl}/admin/keys`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          name: `pvlab-m02-${t0}`,
          expires_in_days: 1,
          created_by: "pvlab-m02",
          upstream_token_id: upstreamId,
          policy: {
            version: "2025-01-01",
            statements: [
              {
                effect: "allow",
                actions: ["supabase:metrics:read"],
                resources: [`project:${ref}`],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const keyText = await keyRes.text();
      let keyJson: KeyCreateResponse = {};
      try {
        keyJson = JSON.parse(keyText) as KeyCreateResponse;
      } catch {
        keyJson = {};
      }
      // The key id IS the Bearer token (shown once, never retrievable).
      keyId = keyJson.result?.key?.id ?? "";
      scopedKey = keyJson.result?.key?.id ?? "";
      put({
        id: "M02b",
        title: titles["M02b"]!,
        status: "info",
        detail: scopedKey ? undefined : "no key secret in the response - check the response shape",
        measurements: { key_create_status: keyRes.status },
        // Same rule as M02a: no gateway error bodies in evidence (the
        // request carried credentials).
      });

      // ---- M02c: proxied scrape + deny controls ----
      const bearer = { Authorization: `Bearer ${scopedKey}` };
      const proxied = await fetch(
        `${gateUrl}/supabase/v1/projects/${ref}/analytics/endpoints/metrics`,
        { headers: bearer, signal: AbortSignal.timeout(60_000) },
      );
      const proxiedText = await proxied.text();
      const families = (proxiedText.match(/^# TYPE /gm) ?? []).length;

      const unclassified = await fetch(`${gateUrl}/supabase/v1/organizations`, {
        headers: bearer,
        signal: AbortSignal.timeout(30_000),
      });
      await unclassified.text();

      const otherRef = await fetch(
        `${gateUrl}/supabase/v1/projects/aaaaaaaaaaaaaaaaaaaa/analytics/endpoints/metrics`,
        { headers: bearer, signal: AbortSignal.timeout(30_000) },
      );
      await otherRef.text();

      put({
        id: "M02c",
        title: titles["M02c"]!,
        status: "info",
        measurements: {
          proxied_status: proxied.status,
          metric_families: families,
          unclassified_status: unclassified.status,
          other_ref_status: otherRef.status,
        },
        // No error-body evidence here either: the proxied request carried
        // the scoped key.
      });

      // ---- M02d: audit trail (supabase proxy events feed) ----
      // The events feed never stores the bearer: key_id is the non-secret
      // preview first4...last4 of the key (the gateway's makePreview).
      // Correlate on that; bounded poll (writes are fire-and-forget).
      const keyPreview = scopedKey.length > 10 ? `${scopedKey.slice(0, 4)}...${scopedKey.slice(-4)}` : "";
      let auditStatus = 0;
      let eventsForKey = 0;
      let auditLagS: number | string = "not_observed";
      const auditT0 = Date.now();
      for (let poll = 0; poll < 10; poll++) {
        const audit = await fetch(
          `${gateUrl}/admin/supabase/analytics/events?${new URLSearchParams({ key_id: keyPreview, limit: "100" })}`,
          { headers: admin, signal: AbortSignal.timeout(30_000) },
        );
        const auditText = await audit.text();
        auditStatus = audit.status;
        try {
          const auditJson = JSON.parse(auditText) as AuditEventsResponse;
          const rows = Array.isArray(auditJson.result) ? auditJson.result : [];
          eventsForKey = rows.filter((e) => e?.key_id === keyPreview).length;
        } catch {
          eventsForKey = 0;
        }
        if (eventsForKey > 0) {
          auditLagS = Math.round((Date.now() - auditT0) / 1000);
          break;
        }
        await sleep(15_000);
      }
      put({
        id: "M02d",
        title: titles["M02d"]!,
        status: "info",
        detail: eventsForKey === 0 ? "no proxy events for the minted key after 150s of polling" : undefined,
        measurements: { audit_status: auditStatus, events_for_key: eventsForKey, audit_lag_s: auditLagS },
      });
    } catch (e) {
      // Rows that never ran get a fail with the reason; rows already pushed stand.
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of Object.keys(titles)) {
        if (!out.has(id)) {
          out.set(id, { id, title: titles[id]!, status: "fail", detail: `aborted: ${msg}` });
        }
      }
    } finally {
      if (keyId) {
        await fetch(`${gateUrl}/admin/keys/${keyId}`, {
          method: "DELETE",
          headers: admin,
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
      }
      if (upstreamId) {
        await fetch(`${gateUrl}/admin/upstream-tokens/${upstreamId}`, {
          method: "DELETE",
          headers: admin,
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
      }
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }

    return [...out.values()];
  },
};
export default mod;
