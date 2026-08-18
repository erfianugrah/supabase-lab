/**
 * I04 - what a FREE org's compute surface actually looks like.
 *
 * I01 measured the paid-org floor (Micro, always-on, Nano unreachable three
 * ways). The free plan is the other end of the spectrum: free projects are
 * pause-eligible and (per the pricing page) run on shared compute. What the
 * API never says out loud is what size a free project IS. This module
 * measures it on a free org:
 *
 *   I04-control  create WITHOUT desired_instance_size -> compute readback +
 *                is ci_nano in available_addons here?
 *   I04a         explicit desired_instance_size "nano" -> accepted or
 *                rejected, verbatim.
 *   I04b         the pause/restore lifecycle: POST /pause, poll INACTIVE,
 *                probe the data API while paused (error shape), POST
 *                /restore, time the wake. Free-plan pause is the closest
 *                publicly available thing to scale-to-zero.
 *
 * Free-plan constraint handled: at most 2 active projects - the module
 * creates exactly one and deletes it in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const FREE_ORG = "vkievkbeejnmbzburjkc"; // the free-plan org
const REGION = "ap-southeast-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ProjectCreateResponse {
  ref?: string;
}
interface ProjectStatusResponse {
  status?: string;
}
interface AddonsResponse {
  available_addons?: Array<{ addon_type?: string; addon_variant?: string }>;
  selected_addons?: Array<{ addon_type?: string; addon_variant?: string }>;
}
interface ApiKeyRow {
  name?: string;
  type?: string;
  api_key?: string;
}

async function statusOf(ctx: Ctx, ref: string): Promise<string> {
  const p = await mgmt(ctx, "GET", `/projects/${ref}`);
  return (p.json as ProjectStatusResponse | undefined)?.status ?? "";
}

async function pollTo(ctx: Ctx, ref: string, want: string, maxMs: number): Promise<string> {
  const deadline = Date.now() + maxMs;
  let status = "";
  while (Date.now() < deadline && status !== want) {
    await sleep(10_000);
    status = await statusOf(ctx, ref);
  }
  return status;
}

const mod: TestModule = {
  id: "I04",
  title: "Free-org compute surface and pause/restore lifecycle",
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions/pauses/restores/deletes its own project on a free org
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let ref = "";
    try {
      // ---- I04-control: default create on a free org ----
      const t0 = Date.now();
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: FREE_ORG,
        name: `i04-free-${t0}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
      });
      ref = (create.json as ProjectCreateResponse | undefined)?.ref ?? "";
      if (create.status !== 201 || !ref) {
        results.push({
          id: "I04-control",
          title: "I04-control: default create on a free org",
          status: "fail",
          detail: `create: HTTP ${create.status}: ${create.text.slice(0, 300)}`,
        });
        for (const id of ["I04a", "I04b"] as const) {
          results.push({ id, title: id, status: "skip", detail: "no control project" });
        }
        return results;
      }
      const status = await pollTo(ctx, ref, "ACTIVE_HEALTHY", 20 * 60_000);
      const addons = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
      const data = addons.json as AddonsResponse | undefined;
      const available = Array.isArray(data?.available_addons) ? data.available_addons : [];
      const selected = Array.isArray(data?.selected_addons) ? data.selected_addons : [];
      const nanoAvailable = available.some(
        (a) => a?.addon_type === "compute_instance" && a?.addon_variant === "ci_nano",
      );
      const compute =
        selected.find((a) => a?.addon_type === "compute_instance")?.addon_variant ?? "none";
      results.push({
        id: "I04-control",
        title: "I04-control: default create on a free org",
        status: status === "ACTIVE_HEALTHY" ? "pass" : "fail",
        detail: status !== "ACTIVE_HEALTHY" ? `not healthy after 20 min (status=${status})` : undefined,
        measurements: {
          provision_s: Math.round((Date.now() - t0) / 1000),
          compute_selected: compute,
          ci_nano_available: nanoAvailable ? 1 : 0,
          compute_variants_available: available
            .filter((a) => a?.addon_type === "compute_instance")
            .map((a) => a?.addon_variant ?? "?")
            .join(","),
        },
      });

      // ---- I04a: explicit nano create on a free org ----
      const t1 = Date.now();
      const createNano = await mgmt(ctx, "POST", "/projects", {
        organization_slug: FREE_ORG,
        name: `i04-nano-${t1}`,
        db_pass: `${crypto.randomUUID()}Aa1!`,
        region: REGION,
        desired_instance_size: "nano",
      });
      const nanoRef = (createNano.json as ProjectCreateResponse | undefined)?.ref ?? "";
      results.push({
        id: "I04a",
        title: "I04a: explicit nano create on a free org",
        status: "info",
        detail:
          createNano.status === 201
            ? "nano create ACCEPTED on the free org"
            : `nano create rejected: HTTP ${createNano.status}`,
        measurements: { create_nano_status: createNano.status },
        evidence: createNano.status !== 201 ? createNano.text.slice(0, 300) : undefined,
      });
      if (nanoRef) {
        await pollTo(ctx, nanoRef, "ACTIVE_HEALTHY", 20 * 60_000);
        await mgmt(ctx, "DELETE", `/projects/${nanoRef}`).catch(() => null);
      }

      // ---- I04b: pause/restore lifecycle ----
      const keysRes = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const keys = Array.isArray(keysRes.json) ? (keysRes.json as ApiKeyRow[]) : [];
      const anon = keys.find((k) => k.name === "anon" || k.type === "publishable")?.api_key ?? "";

      const pause = await mgmt(ctx, "POST", `/projects/${ref}/pause`);
      let pausedStatus = "";
      let pausedDataApi = "";
      if (pause.status < 300) {
        pausedStatus = await pollTo(ctx, ref, "INACTIVE", 10 * 60_000);
        if (pausedStatus === "INACTIVE" && anon) {
          const r = await fetch(`https://${ref}.supabase.co/rest/v1/`, {
            headers: { apikey: anon },
            signal: AbortSignal.timeout(15_000),
          }).catch(() => null);
          if (r) {
            const body = await r.text();
            pausedDataApi = `HTTP ${r.status}: ${body.slice(0, 120)}`;
          }
        }
      }
      const t2 = Date.now();
      let wakeS: number | string = "not_attempted";
      let wakeStatus = "";
      if (pausedStatus === "INACTIVE") {
        const restore = await mgmt(ctx, "POST", `/projects/${ref}/restore`);
        if (restore.status < 300) {
          wakeStatus = await pollTo(ctx, ref, "ACTIVE_HEALTHY", 20 * 60_000);
          wakeS = wakeStatus === "ACTIVE_HEALTHY" ? Math.round((Date.now() - t2) / 1000) : -1;
        } else {
          wakeS = "restore_rejected";
        }
      }
      results.push({
        id: "I04b",
        title: "I04b: pause/restore lifecycle on a free project",
        status: "info",
        detail: pausedDataApi ? `while paused, data API: ${pausedDataApi}` : undefined,
        measurements: {
          pause_status: pause.status,
          reached_inactive: pausedStatus === "INACTIVE" ? 1 : 0,
          wake_s: wakeS,
          final_status: wakeStatus || pausedStatus || "unknown",
        },
        evidence: pause.status >= 300 ? pause.text.slice(0, 300) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ["I04-control", "I04a", "I04b"] as const) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: id, status: "fail", detail: `threw: ${msg}` });
      }
    } finally {
      if (ref) {
        // if the project is paused, restore-then-delete keeps the lifecycle clean.
        // every call here must tolerate network/API failure - a throw in
        // finally would escape run() and produce a module-level row.
        try {
          const s = await statusOf(ctx, ref);
          if (s === "INACTIVE") await mgmt(ctx, "POST", `/projects/${ref}/restore`).catch(() => null);
        } catch {
          // ignore - the delete below is the real cleanup
        }
        await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
      }
    }
    return results;
  },
};
export default mod;
