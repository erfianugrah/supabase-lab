/**
 * Z01 - does any Management API READ wake a parked project?
 *
 * The cost question: on the platform plan compute is billed as the
 * auto-pause-adjusted fraction of the hour the database ran, so a call that
 * wakes a parked tenant starts billing. A platform polling its tenants from a
 * status page or a nightly inventory job would then be generating its own
 * tenants' compute bills. This measures whether the read surface does that.
 *
 *   Z01a  control: SfP-path create (no desired_instance_size) comes up healthy;
 *         record the compute size it landed on.
 *   Z01b  awake baseline: every parameter-free project GET against the healthy
 *         project. The comparison set for Z01d - without it a paused 200 and a
 *         healthy 200 are indistinguishable.
 *   Z01c  pause: POST /pause, time the transition to INACTIVE, and record what
 *         the data plane answers while parked.
 *   Z01d  the wake matrix: every GET again, one at a time, re-reading project
 *         status from the ORG-scoped listing after each. Status still INACTIVE
 *         means that endpoint did not wake it. This is the answer.
 *   Z01e  silent degraders: the endpoints that answer 200 with an EMPTY body
 *         while parked, so a status-code check cannot tell "nothing to report"
 *         from "could not look". Compared against the measured set in lib, so
 *         a NEW member fails rather than passing quietly.
 *   Z01f  restore: prove reversibility and time the wake.
 *
 * A measured 4xx/5xx on a parked project is DATA (info), never a failure - the
 * point is which code each endpoint chooses. The project is restored (so DELETE
 * is accepted) and deleted in `finally`.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  PARAMLESS_GETS,
  SILENT_DEGRADERS,
  projectStatus,
  queryFor,
  waitStatus,
} from "../lib/surface.js";

interface Reading {
  endpoint: string;
  http: number;
  ms: number;
  bytes: number;
  statusAfter?: string;
}

/** Sweep the GET surface once. `org`/`ref` present => re-read status per call. */
async function sweep(
  ctx: Ctx,
  ref: string,
  opts: { org?: string } = {},
): Promise<Reading[]> {
  const out: Reading[] = [];
  for (const ep of PARAMLESS_GETS) {
    const t0 = Date.now();
    const r = await mgmt(ctx, "GET", `/projects/${ref}${ep}${queryFor(ep)}`).catch(() => null);
    const ms = Date.now() - t0;
    const reading: Reading = {
      endpoint: ep || "(project root)",
      http: r?.status ?? 0,
      ms,
      bytes: r?.text.length ?? 0,
    };
    if (opts.org) {
      // Give an async wake a chance to register before reading status back.
      await new Promise((res) => setTimeout(res, 5_000));
      reading.statusAfter = await projectStatus(ctx, opts.org, ref);
    }
    out.push(reading);
  }
  return out;
}

const tsv = (rows: Reading[]) =>
  ["endpoint\thttp\tms\tbytes\tstatus_after"]
    .concat(rows.map((r) => `${r.endpoint}\t${r.http}\t${r.ms}\t${r.bytes}\t${r.statusAfter ?? "-"}`))
    .join("\n");

const mod: TestModule = {
  id: "Z01",
  title: "Does any Management API read wake a parked project?",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const org = ctx.orgSlugs[0] ?? "";
    const ids = ["Z01a", "Z01b", "Z01c", "Z01d", "Z01e", "Z01f"] as const;
    const have = (id: string) => results.some((r) => r.id === id);
    let ref = "";

    try {
      // --- Z01a: control. No desired_instance_size = the SfP create path. ---
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: org,
        name: `z01-s2z-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: "ap-southeast-1",
      });
      ref =
        (create.json as { ref?: string; id?: string } | undefined)?.ref ??
        (create.json as { ref?: string; id?: string } | undefined)?.id ??
        "";
      if (create.status !== 201 || !ref) {
        results.push({
          id: "Z01a",
          title: "Z01a: control",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
        return results;
      }
      const healthy = await waitStatus(ctx, org, ref, "ACTIVE_HEALTHY");
      const listing = await mgmt(ctx, "GET", `/organizations/${org}/projects`);
      const compute =
        (listing.json as { projects?: { ref?: string; databases?: { infra_compute_size?: string }[] }[] } | undefined)
          ?.projects?.find((p) => p?.ref === ref)?.databases?.[0]?.infra_compute_size ?? "unknown";
      results.push({
        id: "Z01a",
        title: "Z01a: control",
        status: healthy.reached ? "pass" : "fail",
        detail: healthy.reached
          ? `healthy in ${healthy.seconds}s on ${compute}`
          : `not healthy (saw ${healthy.seen.join(",")})`,
        measurements: {
          provision_s: healthy.seconds,
          compute_size: compute,
          is_nano: compute === "nano" ? 1 : 0,
        },
      });

      // Seed a REAL advisor finding. Without it the security advisor reads
      // `{"lints":[]}` awake and parked alike on a fresh project, and Z01e
      // cannot tell "no findings" from "could not look" - which is the whole
      // question. A public table with RLS disabled trips a known lint.
      const seed = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, {
        query: "create table if not exists public.z01_rls_off(i int);",
      }).catch(() => null);

      // --- Z01b: awake baseline ---
      const awake = await sweep(ctx, ref);
      results.push({
        id: "Z01b",
        title: "Z01b: awake baseline over the GET surface",
        status: "info",
        detail: `${awake.length} endpoints; ${awake.filter((r) => r.http === 200).length} answered 200`,
        measurements: {
          endpoints: awake.length,
          advisor_seed_status: seed?.status ?? 0,
          awake_200: awake.filter((r) => r.http === 200).length,
          awake_non2xx: awake.filter((r) => r.http < 200 || r.http >= 300).length,
          slowest_ms: Math.max(...awake.map((r) => r.ms)),
        },
        evidence: tsv(awake),
      });

      // --- Z01c: pause ---
      const pause = await mgmt(ctx, "POST", `/projects/${ref}/pause`, {});
      const parked = await waitStatus(ctx, org, ref, "INACTIVE", 600);
      const dpT0 = Date.now();
      const dp = await fetch(
        `https://${ref}.${ctx.apiHostSuffix ?? "supabase.co"}/rest/v1/`,
        { signal: AbortSignal.timeout(60_000) },
      ).catch(() => null);
      results.push({
        id: "Z01c",
        title: "Z01c: pause",
        status: "info",
        detail: parked.reached
          ? `pause ${pause.status} -> INACTIVE in ${parked.seconds}s via ${parked.seen.join(",")}`
          : `never reached INACTIVE (saw ${parked.seen.join(",")})`,
        measurements: {
          pause_status: pause.status,
          to_inactive_s: parked.seconds,
          reached_inactive: parked.reached ? 1 : 0,
          dataplane_http: dp?.status ?? 0,
          dataplane_ms: Date.now() - dpT0,
        },
      });

      if (!parked.reached) {
        for (const id of ["Z01d", "Z01e"] as const) {
          results.push({ id, title: id, status: "skip", detail: "project never parked" });
        }
      } else {
        // --- Z01d: the wake matrix ---
        const paused = await sweep(ctx, ref, { org });
        const wakers = paused.filter((r) => r.statusAfter && r.statusAfter !== "INACTIVE");
        const byEp = new Map(awake.map((r) => [r.endpoint, r]));
        const changed = paused.filter((r) => byEp.get(r.endpoint)?.http !== r.http);
        results.push({
          id: "Z01d",
          title: "Z01d: wake matrix over the GET surface",
          status: "info",
          detail:
            wakers.length === 0
              ? `no waker: all ${paused.length} reads left the project INACTIVE`
              : `WAKERS: ${wakers.map((w) => w.endpoint).join(", ")}`,
          measurements: {
            endpoints: paused.length,
            wakers: wakers.length,
            status_changed_vs_awake: changed.length,
            slowest_ms: Math.max(...paused.map((r) => r.ms)),
          },
          evidence: tsv(paused),
        });

        // --- Z01e: silent degraders ---
        // Compared against the AWAKE pass on the SAME project, not against a
        // size threshold alone. Plenty of endpoints are legitimately `[]` on a
        // fresh project (actions, branches, functions, secrets), and flagging
        // those reports eight false degraders - which is exactly what the first
        // run of this module did.
        const awakeBytes = new Map(awake.map((r) => [r.endpoint, r]));
        const silent = paused
          .filter((r) => {
            if (r.http !== 200 || r.bytes > 14) return false;
            const a = awakeBytes.get(r.endpoint);
            return a !== undefined && a.http === 200 && a.bytes > 14;
          })
          .map((r) => r.endpoint)
          .sort();
        const expected = [...SILENT_DEGRADERS].sort();
        const unexpected = silent.filter((s) => !expected.includes(s as never));
        results.push({
          id: "Z01e",
          title: "Z01e: endpoints that answer 200 with an empty body while parked",
          status: unexpected.length === 0 ? "pass" : "fail",
          detail:
            unexpected.length === 0
              ? `${silent.length} silent degraders, all known: ${silent.join(", ")}`
              : `NEW silent degrader(s): ${unexpected.join(", ")} - a caller checking status codes cannot see these fail`,
          measurements: {
            silent_degraders: silent.length,
            unexpected: unexpected.length,
          },
          evidence: `measured: ${silent.join(", ")}\nexpected: ${expected.join(", ")}`,
        });
      }

      // --- Z01f: restore ---
      const st = await projectStatus(ctx, org, ref);
      if (st === "INACTIVE") {
        const restore = await mgmt(ctx, "POST", `/projects/${ref}/restore`, {});
        const back = await waitStatus(ctx, org, ref, "ACTIVE_HEALTHY", 900);
        results.push({
          id: "Z01f",
          title: "Z01f: restore",
          status: "info",
          detail: `restore ${restore.status} -> ${back.reached ? `healthy in ${back.seconds}s` : "TIMEOUT"} via ${back.seen.join(",")}`,
          measurements: {
            restore_status: restore.status,
            to_healthy_s: back.seconds,
            reached_healthy: back.reached ? 1 : 0,
          },
        });
      } else {
        results.push({
          id: "Z01f",
          title: "Z01f: restore",
          status: "skip",
          detail: `project was ${st}, not INACTIVE`,
        });
      }

      for (const id of ids) {
        if (!have(id)) results.push({ id, title: id, status: "skip", detail: "row never produced" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) {
        if (!have(id)) results.push({ id, title: id, status: "fail", detail: `test threw: ${msg}` });
      }
    } finally {
      if (ref) {
        const st = await projectStatus(ctx, ctx.orgSlugs[0] ?? "", ref).catch(() => "ERR");
        if (st === "INACTIVE" || st === "PAUSING") {
          await mgmt(ctx, "POST", `/projects/${ref}/restore`, {}).catch(() => null);
          await waitStatus(ctx, ctx.orgSlugs[0] ?? "", ref, "ACTIVE_HEALTHY", 900).catch(() => null);
        }
        await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      }
    }
    return results;
  },
};
export default mod;
