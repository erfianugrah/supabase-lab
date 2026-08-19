/**
 * D01 - per-compute-size Postgres limits, measured not doc-quoted.
 *
 * The docs publish a per-size table (max_connections, pooler clients,
 * replication slots, WAL senders) as bare numbers. This module provisions a
 * Pro-org project (floor = Micro, per I01), reads the four settings from
 * pg_settings, resizes it to Small via the addons API, and re-reads them.
 * The resize window is measured too, against the platform-downtime baseline
 * (131-207 s pooler on micro->small).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni";
const REGION = "ap-southeast-1";
const WATCHED = ["max_connections", "max_wal_senders", "max_replication_slots", "shared_buffers"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sql(ctx: Ctx, ref: string, query: string): Promise<any[]> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  if (r.status >= 300 || !r.json) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json as any[];
}

async function settingsOf(ctx: Ctx, ref: string, firstCall = false): Promise<Record<string, string>> {
  if (firstCall) {
    // ACTIVE_HEALTHY is not readiness (AGENTS.md) - the first DB query can
    // refuse for tens of seconds after the status flips. Retry with backoff.
    let lastErr: unknown = null;
    for (let i = 0; i < 12; i += 1) {
      try {
        return await rawSettings(ctx, ref);
      } catch (e) {
        lastErr = e;
        await sleep(5_000);
      }
    }
    throw lastErr;
  }
  return rawSettings(ctx, ref);
}

async function rawSettings(ctx: Ctx, ref: string): Promise<Record<string, string>> {
  const rows = await sql(
    ctx,
    ref,
    `select name, setting from pg_settings where name in (${WATCHED.map((n) => `'${n}'`).join(",")})`,
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[(row as { name: string }).name] = String((row as { setting: unknown }).setting);
  return out;
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

const mod: TestModule = {
  id: "D01",
  title: "pg_settings per compute size (micro vs small)",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions its own project and resizes it
  async run(ctx: Ctx): Promise<TestResult[]> {
    let ref = "";
    const results: TestResult[] = [];
    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `d01-size-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        results.push({ id: "D01", title: "D01", status: "fail", detail: `create: HTTP ${create.status}` });
        return results;
      }
      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`project not healthy: ${status}`);

      const micro = await settingsOf(ctx, ref, true);

      const t1 = Date.now();
      const patch = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
        addon_type: "compute_instance",
        addon_variant: "ci_small",
      });
      let resizeStatus = "";
      const rezDeadline = Date.now() + 20 * 60_000;
      await sleep(5_000);
      while (Date.now() < rezDeadline && resizeStatus !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        resizeStatus = await statusOf(ctx, ref);
      }
      const resizeS = Math.round((Date.now() - t1) / 1000);

      let small: Record<string, string> = {};
      if (patch.status < 300 && resizeStatus === "ACTIVE_HEALTHY") {
        small = await settingsOf(ctx, ref);
      }

      const meas: Record<string, number | string> = {
        resize_to_small_s: resizeStatus === "ACTIVE_HEALTHY" ? resizeS : -1,
      };
      for (const n of WATCHED) {
        meas[`micro_${n}`] = micro[n] ?? "?";
        meas[`small_${n}`] = small[n] ?? "?";
      }
      results.push({
        id: "D01",
        title: "D01: pg_settings per compute size",
        status: patch.status < 300 && resizeStatus === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail:
          patch.status >= 300
            ? `resize rejected: HTTP ${patch.status}: ${patch.text.slice(0, 300)}`
            : `resize to small settled in ${resizeS}s`,
        measurements: meas,
        evidence: patch.status >= 300 ? patch.text.slice(0, 400) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!results.some((r) => r.id === "D01")) {
        results.push({ id: "D01", title: "D01", status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
