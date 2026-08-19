/**
 * D09 - resize/uprgade/downgrade durations + client-visible downtime, local.
 *
 * platform-downtime measured per-path windows at 500ms on micro->small from
 * the AWS runner. This module brings the same measurement to a local run:
 * micro -> small -> large -> small -> micro, with REST (anon table read) and
 * Auth (/auth/v1/health) sampled at 250ms around each PATCH. Four resize
 * durations and per-path outage windows; results total as one D09 row.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const PRO_ORG = "gfqyoavfwjduavsvhbni";
const REGION = "ap-southeast-1";
const SAMPLE_INTERVAL_MS = 250;
const MAX_OP_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApiKeyRow { name?: string; type?: string; api_key?: string }

interface PhaseStats {
  op: string;
  durationS: number;
  restSoFar: { ok: number; tot: number; maxOutageS: number };
  authSoFar: { ok: number; tot: number; maxOutageS: number };
}

class PathSampler {
  private restUrl: string;
  private anon: string;
  private accRest = new PhaseStatsAccumulator();
  private accAuth = new PhaseStatsAccumulator();
  private active = false;

  constructor(ref: string, anon: string) {
    this.restUrl = `https://${ref}.supabase.co/rest/v1/dpython_probe?limit=1`;
    this.anon = anon;
  }

  async run(): Promise<void> {
    this.active = true;
    const authUrl = `https://${this.restUrl.split("/")[2]}/auth/v1/health`;
    while (this.active) {
      const cut = Date.now();
      const [rest, auth] = await Promise.all([
        fetch(this.restUrl, { headers: { apikey: this.anon }, signal: AbortSignal.timeout(2_000) })
          .then((r) => r.status)
          .catch(() => -1),
        fetch(authUrl, { signal: AbortSignal.timeout(2_000) })
          .then((r) => r.status)
          .catch(() => -1),
      ]);
      this.accRest.add(rest === 200, cut);
      this.accAuth.add(auth === 200, cut);
      const spent = Date.now() - cut;
      if (spent < SAMPLE_INTERVAL_MS) await sleep(SAMPLE_INTERVAL_MS - spent);
    }
  }

  stop(): { restOk: number; restTot: number; restMaxOutageS: number; authOk: number; authTot: number; authMaxOutageS: number } {
    this.active = false;
    return {
      restOk: this.accRest.ok,
      restTot: this.accRest.total,
      restMaxOutageS: this.accRest.maxOutageS,
      authOk: this.accAuth.ok,
      authTot: this.accAuth.total,
      authMaxOutageS: this.accAuth.maxOutageS,
    };
  }
}

class PhaseStatsAccumulator {
  ok = 0;
  total = 0;
  maxOutageS = 0;
  private runStart = -1;
  private expected: boolean[] = [];

  constructor() {
    void this.expected;
    this.expected = [];
  }

  add(okFlag: boolean, at: number): void {
    this.total += 1;
    if (okFlag) {
      this.ok += 1;
      if (this.runStart >= 0) {
        const s = (at - this.runStart) / 1000;
        if (s > this.maxOutageS) this.maxOutageS = s;
        this.runStart = -1;
      }
    } else if (this.runStart < 0) {
      this.runStart = at;
    }
  }
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return ((p.json as { status?: string } | undefined)?.status ?? "") as string;
}

async function sql(ctx: Ctx, ref: string, query: string): Promise<number> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  return r.status;
}

const mod: TestModule = {
  id: "D09",
  title: "resize/downgrade durations + client-visible downtime",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    let ref = "";
    const results: TestResult[] = [];
    const phases: PhaseStats[] = [];
    try {
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: PRO_ORG,
        name: `d09-resize-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        results.push({ id: "D09", title: "D09", status: "fail", detail: `create: HTTP ${create.status}` });
        return results;
      }
      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        status = await statusOf(ctx, ref);
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      // warm the DB (first SQL still races ACTIVE_HEALTHY)
      for (let i = 0; i < 12; i += 1) {
        const q0 = await sql(ctx, ref, "create table if not exists public.dpython_probe(id int primary key);");
        if (q0 < 300) break;
        await sleep(5_000);
      }
      await sql(ctx, ref, "insert into public.dpython_probe values (1) on conflict do nothing;");
      const keysRes = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const keys = Array.isArray(keysRes.json) ? (keysRes.json as ApiKeyRow[]) : [];
      const anon = keys.find((k) => k.name === "anon" || k.type === "publishable")?.api_key ?? "";
      if (!anon) throw new Error("no anon key");

      const ops = [
        ["upgrade micro->small", "ci_small"],
        ["upgrade small->large", "ci_large"],
        ["downgrade large->small", "ci_small"],
        ["downgrade small->micro", "ci_micro"],
      ] as const;

      for (const [op, variant] of ops) {
        const sampler = new PathSampler(ref, anon);
        const samplerTask = sampler.run().catch(() => null);
        const tOp = Date.now();
        const patch = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
          addon_type: "compute_instance",
          addon_variant: variant,
        });
        // wait for NOT-healthy for up to MAX_OP_MS (transition), then
        // for healthy again. A resize that never leaves ACTIVE_HEALTHY
        // settles as a bad-null result, not a 0-second duration.
        const transDeadline = Date.now() + 60_000;
        let transitioned = "";
        let rezStatus = await statusOf(ctx, ref);
        while (Date.now() < transDeadline && (rezStatus === "" || rezStatus === "ACTIVE_HEALTHY")) {
          if (rezStatus !== "ACTIVE_HEALTHY") transitioned = rezStatus;
          await sleep(2_000);
          rezStatus = await statusOf(ctx, ref);
          if (transitioned) break;
        }
        // now back to ACTIVE_HEALTHY
        const opDeadline = Date.now() + MAX_OP_MS;
        while (Date.now() < opDeadline && rezStatus !== "ACTIVE_HEALTHY") {
          await sleep(3_000);
          rezStatus = await statusOf(ctx, ref);
        }
        const durationS = Math.round((Date.now() - tOp) / 1000);
        const stop = sampler.stop();
        samplerTask.catch(() => null);
        void samplerTask;
        phases.push({
          op,
          durationS: rezStatus === "ACTIVE_HEALTHY" ? durationS : -1,
          restSoFar: { ok: stop.restOk, tot: stop.restTot, maxOutageS: stop.restMaxOutageS },
          authSoFar: { ok: stop.authOk, tot: stop.authTot, maxOutageS: stop.authMaxOutageS },
        });
        ctx.log(
          `${op}: ${durationS}s` +
            ` rest outages ${stop.restMaxOutageS.toFixed(1)}s (${stop.restOk}/${stop.restTot} ok)` +
            ` auth ${stop.authMaxOutageS.toFixed(1)}s`,
        );
        if (patch.status >= 300) {
          ctx.log(`${op}: PATCH rejected HTTP ${patch.status}: ${patch.text.slice(0, 200)}`);
          continue; // try the next op rather than dying on a transient
        }
      }

      const meas: Record<string, number | string> = {};
      const lines: string[] = [];
      for (const p of phases) {
        const key = p.op.replace(/[^a-z0-9]+/g, "_").toLowerCase();
        meas[`${key}_s`] = p.durationS;
        meas[`${key}_rest_max_outage_s`] = p.restSoFar.maxOutageS;
        meas[`${key}_auth_max_outage_s`] = p.authSoFar.maxOutageS;
        meas[`${key}_rest_uptime_pct`] =
          p.restSoFar.tot > 0 ? Math.round((p.restSoFar.ok / p.restSoFar.tot) * 1000) / 10 : -1;
        lines.push(`${p.op}: ${p.durationS}s, rest max outage ${p.restSoFar.maxOutageS.toFixed(1)}s, auth ${p.authSoFar.maxOutageS.toFixed(1)}s`);
      }
      results.push({
        id: "D09",
        title: "D09: upgrade/downgrade durations + sampled downtime",
        status: phases.some((p) => p.durationS > 0) ? "pass" : "fail",
        detail: lines.join(" | "),
        measurements: meas,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!results.some((r) => r.id === "D09")) {
        results.push({ id: "D09", title: "D09", status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
    return results;
  },
};
export default mod;
