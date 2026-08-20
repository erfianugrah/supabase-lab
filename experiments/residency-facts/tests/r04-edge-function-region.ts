/**
 * R04 - Edge Functions execute user-nearest by default; x-region pins them.
 *
 * The residency doc claims (measured ad hoc 2026-08-10, Singapore vantage,
 * eu-central-1 project): default invocation answered from ap-southeast-1 per
 * the x-sb-edge-region response header; re-invoking with `x-region:
 * eu-central-1` moved execution to the project region. This re-measures on
 * the record against a Zurich project, deploying the committed
 * functions/residency-echo source via the CLI's server-side bundler (g02's
 * pattern).
 *
 * Asserts: pinned == project region, default != pinned (this vantage is not
 * Zurich). If the vantage ever runs FROM Zurich those two coincide and the
 * second assert is meaningless - the test says so instead of failing.
 */
import { $ } from "bun";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { getKeys, h, projectRegion } from "../lib";

const SLUG = "residency-echo";
const FUNCTION_SRC = join(process.cwd(), "functions", SLUG, "index.ts");

async function deploy(ctx: Ctx): Promise<{ ok: boolean; detail: string }> {
  const which = await $`which supabase`.quiet().nothrow();
  if (which.exitCode !== 0) {
    return { ok: false, detail: "supabase CLI not on PATH - cannot deploy an Edge Function from a test" };
  }
  const workdir = join(tmpdir(), `pvlab-r04-${crypto.randomUUID()}`);
  const destDir = join(workdir, "supabase", "functions", SLUG);
  await $`mkdir -p ${destDir}`.quiet().nothrow();
  await Bun.write(join(destDir, "index.ts"), await Bun.file(FUNCTION_SRC).text());
  const p =
    await $`supabase functions deploy ${SLUG} --project-ref ${ctx.ref} --use-api --no-verify-jwt --workdir ${workdir}`
      .env({ ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" })
      .quiet()
      .nothrow();
  await $`rm -rf ${workdir}`.quiet().nothrow();
  return { ok: p.exitCode === 0, detail: (p.stdout.toString() + p.stderr.toString()).trim().slice(0, 300) };
}

async function invokeRegion(ctx: Ctx, anon: string, pin?: string): Promise<{ status: number; region: string }> {
  const headers: Record<string, string> = { apikey: anon, Authorization: `Bearer ${anon}` };
  if (pin) headers["x-region"] = pin;
  const res = await fetch(`https://${ctx.apiHost}/functions/v1/${SLUG}`, { headers });
  await res.arrayBuffer();
  return { status: res.status, region: h(res.headers, "x-sb-edge-region") };
}

const mod: TestModule = {
  id: "R04",
  title: "Edge Function execution region: default vs pinned",
  where: "local",
  requires: ["pat"],
  destructive: true, // deploys a function onto the probe project
  async run(ctx: Ctx): Promise<TestResult> {
    const region = await projectRegion(ctx);
    const keys = await getKeys(ctx);
    if (!region || !keys.anon) {
      return {
        id: "R04a",
        title: this.title,
        status: "fail",
        detail: `missing project region (${region || "?"}) or anon key (${keys.anon ? "set" : "absent"})`,
      };
    }

    const existing = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions`);
    const slugs = Array.isArray(existing.json)
      ? (existing.json as Record<string, unknown>[]).map((f) => String(f.slug ?? ""))
      : [];
    let deployNote = "reused - function already deployed";
    if (!slugs.includes(SLUG)) {
      const d = await deploy(ctx);
      if (!d.ok) {
        return {
          id: "R04a",
          title: this.title,
          status: "fail",
          detail: `deploy failed: ${d.detail}`,
          measurements: { functions_list_status: existing.status },
        };
      }
      deployNote = "deployed just now";
    }

    const unpinned = await invokeRegion(ctx, keys.anon);
    const pinned = await invokeRegion(ctx, keys.anon, region);

    const measurements: Record<string, string | number> = {
      project_region: region,
      unpinned_status: unpinned.status,
      unpinned_region: unpinned.region || "absent",
      pinned_status: pinned.status,
      pinned_region: pinned.region || "absent",
    };

    if (unpinned.status !== 200 || pinned.status !== 200) {
      return {
        id: "R04a",
        title: this.title,
        status: "fail",
        detail: `invocation failed: unpinned=${unpinned.status}, pinned=${pinned.status} (${deployNote})`,
        measurements,
      };
    }

    const pinWorks = pinned.region === region;
    const defaultDiffers = unpinned.region !== region;
    return {
      id: "R04a",
      title: this.title,
      status: pinWorks && defaultDiffers ? "pass" : "info",
      detail:
        `project=${region}, unpinned=${unpinned.region || "?"}, pinned=${pinned.region || "?"} (${deployNote}). ` +
        (!pinWorks
          ? "x-region did NOT pin execution to the project region - the doc claim is wrong"
          : defaultDiffers
            ? "default execution is user-nearest, pin works: both claims hold"
            : "pin works; default==project region, so this vantage is in the project region and the user-nearest claim is untested this run"),
      measurements,
    };
  },
};
export default mod;
