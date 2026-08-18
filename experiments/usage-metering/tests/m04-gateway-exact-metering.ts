/**
 * M04 - exact per-key metering through the credential-proxy gateway.
 *
 * M02 proved scoped access works (200/403). The metering claim is stronger:
 * if a platform mints one scoped key per tenant, the gateway's event feed is
 * a per-tenant usage ledger. That only holds if the feed is EXACT - this
 * module makes a counted number of proxied calls per key and requires the
 * feed to return exactly that many events, attributed to the right project.
 *
 *   M04-control  gateway reachable + admin key valid.
 *   M04a         setup: provision a throwaway project (tenant A), register
 *                the PAT as an upstream, mint two keys: A scoped to
 *                project:<refA> (supabase:projects:read), B scoped to
 *                project:<standing ref> (supabase:metrics:read).
 *   M04b         exactly 7 proxied reads with key A, exactly 5 with key B.
 *   M04c         poll the proxy-events feed (fire-and-forget writes) until
 *                it shows exactly 7 events for key A and 5 for key B, each
 *                with the correct project_ref and status 200 - or record
 *                the mismatch verbatim.
 *
 * Cleanup in finally: revoke both keys, delete the upstream, delete the
 * throwaway project. No key values in output.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni";
const REGION = "ap-southeast-1";
const STANDING_REF = "qgzvoxftelifyavcqjqa"; // an existing project, read-only target
const CALLS_A = 7;
const CALLS_B = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}

const mod: TestModule = {
  id: "M04",
  title: "Exact per-key usage metering through the credential-proxy gateway",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions+deletes a project, mints+revokes gateway keys
  async run(ctx: Ctx): Promise<TestResult[]> {
    const gateUrl = process.env.GATEKEEPER_URL;
    const adminKey = process.env.GATEKEEPER_ADMIN_KEY;
    const missing = [
      ...(gateUrl ? [] : ["GATEKEEPER_URL"]),
      ...(adminKey ? [] : ["GATEKEEPER_ADMIN_KEY"]),
    ];
    const titles: Record<string, string> = {
      "M04-control": "gateway reachable",
      "M04a": "setup: project + upstream + two scoped keys",
      "M04b": "counted proxied calls",
      "M04c": "events feed exactness",
    };
    if (missing.length > 0) {
      return Object.entries(titles).map(([id, title]) => ({
        id,
        title,
        status: "skip" as const,
        detail: `missing env: ${missing.join(", ")}`,
      }));
    }
    const admin = { "X-Admin-Key": adminKey!, "Content-Type": "application/json" };
    const results: TestResult[] = [];
    let ref = "";
    let upstreamId = "";
    const keyIds: string[] = [];
    const previews: string[] = [];

    try {
      const summary = await fetch(`${gateUrl}/admin/analytics/summary`, {
        headers: admin,
        signal: AbortSignal.timeout(30_000),
      });
      await summary.text();
      results.push({
        id: "M04-control",
        title: titles["M04-control"]!,
        status: summary.status === 200 ? "pass" : "fail",
        measurements: { status: summary.status },
      });
      if (summary.status !== 200) throw new Error("control failed");

      // ---- M04a: setup ----
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `m04-meter-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) throw new Error(`create: HTTP ${create.status}`);
      let status = "";
      for (let i = 0; i < 90 && status !== "ACTIVE_HEALTHY"; i++) {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = (p.json as ProjectStatusResponse | undefined)?.status ?? "";
      }
      const up = await fetch(`${gateUrl}/admin/upstream-tokens`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: `pvlab-m04-${t0}`, token: ctx.pat, scope_type: "supabase", zone_ids: ["*"] }),
        signal: AbortSignal.timeout(30_000),
      });
      const upJson = JSON.parse(await up.text()) as { result?: { id?: string }; id?: string };
      upstreamId = upJson.result?.id ?? upJson.id ?? "";

      const mint = async (name: string, action: string, resource: string) => {
        const r = await fetch(`${gateUrl}/admin/keys`, {
          method: "POST",
          headers: admin,
          body: JSON.stringify({
            name,
            expires_in_days: 1,
            created_by: "pvlab-m04",
            upstream_token_id: upstreamId,
            policy: {
              version: "2025-01-01",
              statements: [{ effect: "allow", actions: [action], resources: [resource] }],
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const j = JSON.parse(await r.text()) as { result?: { key?: { id?: string } } };
        const id = j.result?.key?.id ?? "";
        keyIds.push(id);
        previews.push(id.length > 10 ? `${id.slice(0, 4)}...${id.slice(-4)}` : "");
        return id;
      };
      const keyA = await mint(`pvlab-m04-a-${t0}`, "supabase:projects:read", `project:${ref}`);
      const keyB = await mint(`pvlab-m04-b-${t0}`, "supabase:metrics:read", `project:${STANDING_REF}`);
      results.push({
        id: "M04a",
        title: titles["M04a"]!,
        status: keyA && keyB && upstreamId && status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        measurements: { provision_s: Math.round((Date.now() - t0) / 1000) },
      });

      // ---- M04b: counted calls ----
      let okA = 0;
      let okB = 0;
      for (let i = 0; i < CALLS_A; i++) {
        const r = await fetch(`${gateUrl}/supabase/v1/projects/${ref}`, {
          headers: { Authorization: `Bearer ${keyA}` },
          signal: AbortSignal.timeout(30_000),
        });
        await r.text();
        if (r.status === 200) okA++;
      }
      for (let i = 0; i < CALLS_B; i++) {
        const r = await fetch(`${gateUrl}/supabase/v1/projects/${STANDING_REF}/analytics/endpoints/metrics`, {
          headers: { Authorization: `Bearer ${keyB}` },
          signal: AbortSignal.timeout(60_000),
        });
        await r.text();
        if (r.status === 200) okB++;
      }
      results.push({
        id: "M04b",
        title: titles["M04b"]!,
        status: "info",
        detail: okA !== CALLS_A || okB !== CALLS_B ? "some proxied calls failed - counts below are of SUCCESSES" : undefined,
        measurements: { calls_a_sent: CALLS_A, calls_a_200: okA, calls_b_sent: CALLS_B, calls_b_200: okB },
      });

      // ---- M04c: the feed must show exactly the successful counts ----
      const eventsFor = async (preview: string) => {
        const r = await fetch(
          `${gateUrl}/admin/supabase/analytics/events?${new URLSearchParams({ key_id: preview, limit: "100" })}`,
          { headers: admin, signal: AbortSignal.timeout(30_000) },
        );
        const j = JSON.parse(await r.text()) as { result?: Array<{ key_id?: string; project_ref?: string; status?: number }> };
        return Array.isArray(j.result) ? j.result.filter((e) => e?.key_id === preview) : [];
      };
      let evA: Awaited<ReturnType<typeof eventsFor>> = [];
      let evB: Awaited<ReturnType<typeof eventsFor>> = [];
      for (let poll = 0; poll < 10; poll++) {
        evA = await eventsFor(previews[0] ?? "");
        evB = await eventsFor(previews[1] ?? "");
        if (evA.length >= okA && evB.length >= okB) break;
        await sleep(15_000);
      }
      const aRefOk = evA.filter((e) => e.project_ref === ref).length;
      const bRefOk = evB.filter((e) => e.project_ref === STANDING_REF).length;
      const a200 = evA.filter((e) => e.status === 200).length;
      const b200 = evB.filter((e) => e.status === 200).length;
      results.push({
        id: "M04c",
        title: titles["M04c"]!,
        status: "info",
        detail:
          evA.length === okA && evB.length === okB && aRefOk === okA && bRefOk === okB
            ? undefined
            : "feed counts or attribution diverge from calls made - the ledger is not exact",
        measurements: {
          events_a: evA.length,
          events_a_expected: okA,
          events_a_correct_ref: aRefOk,
          events_a_status_200: a200,
          events_b: evB.length,
          events_b_expected: okB,
          events_b_correct_ref: bRefOk,
          events_b_status_200: b200,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of Object.keys(titles)) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: titles[id]!, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      for (const id of keyIds) {
        if (id) await fetch(`${gateUrl}/admin/keys/${id}`, { method: "DELETE", headers: admin, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      }
      if (upstreamId) {
        await fetch(`${gateUrl}/admin/upstream-tokens/${upstreamId}`, { method: "DELETE", headers: admin, signal: AbortSignal.timeout(15_000) }).catch(() => null);
      }
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
