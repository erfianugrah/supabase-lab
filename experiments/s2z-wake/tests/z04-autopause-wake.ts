/**
 * Z04 - what wakes an AUTOMATICALLY paused project?
 *
 * Phase two. Z03 provisioned one untouched project per candidate; this fires
 * exactly one candidate at each, once the fleet has actually auto-paused.
 *
 * Why one project per candidate: a wake restarts the multi-day inactivity
 * clock, so a project answers exactly ONE question per window. Serial testing
 * would cost one window per candidate.
 *
 * Why `control` matters: it is fired at nothing. If every project in the fleet
 * wakes, including that one, the platform woke them on its own schedule and no
 * other row means anything. Without the control this module can only produce
 * correlation.
 *
 * Reading the result:
 *   - a project still INACTIVE after its candidate fired -> that call does not
 *     wake an auto-paused project
 *   - a project no longer INACTIVE, while `control` stayed INACTIVE -> that
 *     call woke it, and on a production platform org that is a billing event
 *   - `control` itself moved -> discard the run; the fleet was not quiescent
 *
 * This module does NOT delete the fleet. A woken project is a spent subject
 * whose next window is days away, but deleting it silently would destroy the
 * evidence of what woke it. Clean up deliberately, after reading the report.
 *
 * Distinct from Z01/Z02, which measured a MANUALLY paused project - a state
 * with no public DNS record, and therefore one that traffic cannot wake. Auto
 * pause is a different route into the state and may or may not land in the
 * same place; whether it does is Z04b.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { CANDIDATES, FLEET_FILE, type Fire } from "../lib/wake-candidates.js";
import { projectStatus, sleep } from "../lib/surface.js";

interface FleetRow {
  key: string;
  ref: string;
}

async function readFleet(): Promise<FleetRow[]> {
  const f = Bun.file(FLEET_FILE);
  if (!(await f.exists())) return [];
  const lines = (await f.text()).trim().split("\n").slice(1);
  return lines
    .map((l) => l.split("\t"))
    .filter((c) => c.length >= 2 && c[0] && c[1])
    .map((c) => ({ key: c[0]!, ref: c[1]! }));
}

/** Resolve a project's public hostname; NXDOMAIN is itself a reading. */
async function dnsResolves(host: string): Promise<boolean> {
  try {
    await Bun.dns.lookup(host, { family: 0 });
    return true;
  } catch {
    return false;
  }
}

async function fire(ctx: Ctx, f: Fire, ref: string): Promise<{ label: string; result: string }> {
  const suffix = ctx.apiHostSuffix ?? "supabase.co";
  switch (f.kind) {
    case "none":
      return { label: "(nothing)", result: "not fired" };
    case "mgmt": {
      const path = f.path.replace(/\{REF\}/g, ref);
      const r = await mgmt(ctx, f.verb, path, f.body, 120_000).catch(() => null);
      return { label: `${f.verb} ${f.path}`, result: `HTTP ${r?.status ?? 0}` };
    }
    case "dataplane": {
      const url = `https://${ref}.${suffix}${f.path}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(90_000) }).catch(() => null);
      return { label: `GET ${f.path}`, result: r ? `HTTP ${r.status}` : "unreachable" };
    }
    case "tcp": {
      const host = f.hostRole === "db" ? `db.${ref}.${suffix}` : `${ref}.pooler.${suffix}`;
      try {
        const sock = await Bun.connect({ hostname: host, port: f.port, socket: { data() {} } });
        sock.end();
        return { label: `tcp ${f.hostRole}:${f.port}`, result: "connected" };
      } catch (e) {
        return { label: `tcp ${f.hostRole}:${f.port}`, result: `refused (${(e as Error).message.slice(0, 40)})` };
      }
    }
  }
}

const mod: TestModule = {
  id: "Z04",
  title: "What wakes an automatically paused project?",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgSlugs[0] ?? "";
    const fleet = await readFleet();
    if (fleet.length === 0) {
      return [
        {
          id: "Z04a",
          title: "Z04a: fleet readiness",
          status: "skip",
          detail: `no fleet manifest at ${FLEET_FILE} - run Z03 with PVLAB_S2Z_PROVISION=1 first`,
        },
      ];
    }

    // --- Z04a: is the fleet parked? Firing early measures nothing. ---
    const states: Record<string, string> = {};
    for (const row of fleet) states[row.key] = await projectStatus(ctx, org, row.ref);
    const parked = fleet.filter((r) => states[r.key] === "INACTIVE");
    const results: TestResult[] = [
      {
        id: "Z04a",
        title: "Z04a: fleet readiness",
        status: parked.length === fleet.length ? "pass" : "info",
        detail:
          `${parked.length}/${fleet.length} auto-paused` +
          (parked.length === fleet.length ? "" : " - not yet ready; nothing fired"),
        measurements: { fleet: fleet.length, parked: parked.length },
        evidence: fleet.map((r) => `${r.key}\t${states[r.key]}`).join("\n"),
      },
    ];
    if (parked.length !== fleet.length) return results;

    // --- Z04b: does auto-pause land in the same state as a manual pause? ---
    const suffix = ctx.apiHostSuffix ?? "supabase.co";
    const dns: Record<string, boolean> = {};
    for (const r of fleet) dns[r.key] = await dnsResolves(`${r.ref}.${suffix}`);
    const resolving = Object.values(dns).filter(Boolean).length;
    results.push({
      id: "Z04b",
      title: "Z04b: is an auto-paused project shaped like a manually paused one?",
      status: "info",
      detail:
        `${resolving}/${fleet.length} still resolve public DNS. A manual pause tears DNS down ` +
        `(measured 2026-09-09), so ${resolving === 0 ? "auto-pause matches it" : "auto-pause DIFFERS - traffic can still reach these"}`,
      measurements: { dns_resolving: resolving, fleet: fleet.length },
      evidence: fleet.map((r) => `${r.key}\t${dns[r.key] ? "resolves" : "NXDOMAIN"}`).join("\n"),
    });

    // --- Z04c: fire one candidate per project, then read status back ---
    const fired: string[] = [];
    for (const row of fleet) {
      const cand = CANDIDATES.find((c) => c.key === row.key);
      if (!cand) continue;
      const f = await fire(ctx, cand.fire, row.ref);
      fired.push(`${row.key}\t${f.label}\t${f.result}`);
      ctx.log(`fired ${row.key}: ${f.label} -> ${f.result}`);
    }
    // One settle window for the whole fleet rather than per project, so every
    // candidate gets the same amount of time to show an async wake.
    await sleep(120_000);

    const after: Record<string, string> = {};
    for (const row of fleet) after[row.key] = await projectStatus(ctx, org, row.ref);
    const woke = fleet.filter((r) => after[r.key] !== "INACTIVE");
    const controlMoved = after["control"] !== undefined && after["control"] !== "INACTIVE";

    results.push({
      id: "Z04c",
      title: "Z04c: wake verdict per candidate",
      status: controlMoved ? "fail" : "info",
      detail: controlMoved
        ? "DISCARD: the control project woke without being fired at - the fleet was not quiescent, so no row is attributable"
        : woke.length === 0
          ? `no candidate woke an auto-paused project (${fleet.length} tested)`
          : `WOKE: ${woke.map((w) => w.key).join(", ")}`,
      measurements: {
        tested: fleet.length,
        woke: woke.length,
        control_moved: controlMoved ? 1 : 0,
      },
      evidence:
        `candidate\tfired\tresult\tstatus_after\n` +
        fired.map((l) => `${l}\t${after[l.split("\t")[0]!]}`).join("\n"),
    });
    return results;
  },
};
export default mod;
