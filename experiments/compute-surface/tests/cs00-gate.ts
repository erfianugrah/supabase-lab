/**
 * CS00 - is Supabase Compute enabled for a new project on this organization?
 * Reads the gate on the published v2 Management API compute routes, the org's
 * entitlement list, and whether the installed CLI exposes `supabase compute`.
 *
 * Side: the hosted Management API (api.supabase.com) and the Supabase CLI on
 * this machine. Key: the lab PAT (Authorization: Bearer) for every row except
 * CS00g. Project: one throwaway Micro project in ap-southeast-1 on the Pro
 * organization (PVLAB_ORG_PRO), created here and deleted in `finally`.
 * Compute name in the path: `cs00-probe`, which was never deployed.
 *
 *   CS00a  GET /v1/organizations/{slug}/entitlements: total count and every
 *          feature key containing compute, worker, service, container or app,
 *          with hasAccess.
 *   CS00b  GET /v2/projects/{ref}/compute (list). This row decides the gate.
 *   CS00c  GET /v2/projects/{ref}/compute/cs00-probe (get).
 *   CS00d  POST /v2/projects/{ref}/compute/cs00-probe/uploads (upload slot, no
 *          body; the spec defines none).
 *   CS00e  POST /v2/projects/{ref}/compute/cs00-probe/deploy with a
 *          schema-valid body (runtime deno, size 2gb, exposure private,
 *          instances 1, no upload). Sent ONLY when CS00b answered
 *          compute_not_enabled, so an enrolled project is never deployed to
 *          by this module; with the gate open the row is a skip.
 *   CS00f  DELETE /v2/projects/{ref}/compute/cs00-probe (nothing to delete).
 *   CS00g  control: the list call with no Authorization header.
 *   CS00h  CLI: installed version, the npm dist-tags, `supabase compute
 *          --help` with and without SUPABASE_EXPERIMENTAL_COMPUTE=1 and with
 *          the global `--experimental` flag, and the read-only `supabase
 *          compute list --project-ref` against the project with the env var
 *          set. Nothing is pushed or deployed.
 *   CS00   summary: gate = closed (list answered 404 compute_not_enabled),
 *          open (list answered 2xx) or unclear (anything else, read by hand).
 *
 * Every row is `info`: the expected answer today is `closed`, and a later
 * enrollment shows as a changed `gate` measurement under `pvlab --diff`.
 * Status, error code and body are kept verbatim (body trimmed to 600
 * characters) in `measurements` and `evidence`.
 *
 * Not settled by this module: anything about Compute once enabled (deploy
 * path, serving, idle, limits: CS01-CS07 in the README); whether another
 * organization or plan is enrolled; whether enrollment is visible to a PAT
 * anywhere other than these routes and the entitlement list.
 *
 * DESTRUCTIVE: creates one Micro project, deleted in finally. Self-skips
 * without PVLAB_ORG_PRO.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { SB, baseEnv, run } from "../../cli-surface/lib/cli";
import { type RawAnswer, dropProject, gateOf, makeMicro, v2 } from "../lib/cs";

const NAME = "cs00-probe";
const KEY_RX = /compute|worker|service|container|app/i;
const COMPUTE_RX = /Manage Supabase Compute/;

interface Ent {
  feature?: { key?: string; type?: string };
  hasAccess?: boolean;
}

const row = (id: string, title: string, a: RawAnswer, extra: Record<string, number | string> = {}): TestResult => ({
  id,
  title,
  status: "info",
  detail: `HTTP ${a.status} ${a.code || "(no error.code)"}`,
  measurements: { http_status: a.status, error_code: a.code || "-", gate_reading: gateOf(a), ...extra },
  evidence: a.body,
});

const mod: TestModule = {
  id: "CS00",
  title: "Compute enrollment gate: v2 compute routes, org entitlements, CLI command",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro;
    if (!org) return [{ id: "CS00", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    let gate = "unclear";
    const routes: string[] = [];
    try {
      // CS00a - entitlements (org-level, no project needed)
      const ents = await mgmt(ctx, "GET", `/organizations/${org}/entitlements`);
      const list = ((ents.json as { entitlements?: Ent[] } | undefined)?.entitlements ?? []) as Ent[];
      const hits = list.filter((e) => KEY_RX.test(e.feature?.key ?? "")).map((e) => `${e.feature?.key}=${e.hasAccess === undefined ? "?" : e.hasAccess}`);
      out.push({
        id: "CS00a",
        title: "org entitlements: keys containing compute/worker/service/container/app",
        status: "info",
        detail: `HTTP ${ents.status}, ${list.length} entitlements, ${hits.length} matching key(s)`,
        measurements: { http_status: ents.status, entitlements_total: list.length, matching_keys: hits.length, matches: hits.join(" ") || "-" },
      });

      const p = await makeMicro(ctx, "cs00");
      ref = p.ref;
      out.push({
        id: "CS00p",
        title: "throwaway project",
        status: "info",
        detail: `ACTIVE_HEALTHY after ${Math.round(p.healthyMs / 1000)} s, size ${p.instanceSize}`,
        measurements: { region: "ap-southeast-1", instance_size: p.instanceSize, healthy_s: Math.round(p.healthyMs / 1000) },
      });

      // CS00b - list decides the gate
      const list2 = await v2(ctx, "GET", `/projects/${ref}/compute`);
      gate = gateOf(list2);
      routes.push(`list ${list2.status} ${list2.code || "-"}`);
      out.push(row("CS00b", "GET /v2/projects/{ref}/compute (list)", list2));

      const get = await v2(ctx, "GET", `/projects/${ref}/compute/${NAME}`);
      routes.push(`get ${get.status} ${get.code || "-"}`);
      out.push(row("CS00c", `GET /v2/projects/{ref}/compute/${NAME} (get)`, get));

      const up = await v2(ctx, "POST", `/projects/${ref}/compute/${NAME}/uploads`);
      routes.push(`uploads ${up.status} ${up.code || "-"}`);
      out.push(row("CS00d", `POST /v2/projects/{ref}/compute/${NAME}/uploads (upload slot)`, up));

      if (gate === "closed") {
        const dep = await v2(ctx, "POST", `/projects/${ref}/compute/${NAME}/deploy`, {
          data: { type: "project_compute_instance", attributes: { spec: { runtime: "deno", size: "2gb", exposure: "private", instances: 1 } } },
        });
        routes.push(`deploy ${dep.status} ${dep.code || "-"}`);
        out.push(row("CS00e", `POST /v2/projects/{ref}/compute/${NAME}/deploy (schema-valid body, no upload)`, dep));
      } else {
        out.push({ id: "CS00e", title: "deploy", status: "skip", detail: `list answered gate=${gate}; deploy is CS01's job, not sent` });
      }

      const del = await v2(ctx, "DELETE", `/projects/${ref}/compute/${NAME}`);
      routes.push(`delete ${del.status} ${del.code || "-"}`);
      out.push(row("CS00f", `DELETE /v2/projects/{ref}/compute/${NAME} (never deployed)`, del));

      const anon = await v2(ctx, "GET", `/projects/${ref}/compute`, undefined, false);
      out.push(row("CS00g", "control: list with no Authorization header", anon));

      // CS00h - CLI, read-only
      const dir = mkdtempSync(join(tmpdir(), "cs00-"));
      const ver = await run([SB, "--version"], { cwd: dir, timeoutMs: 30_000 }).catch(() => null);
      const tags = await run(["npm", "view", "supabase", "dist-tags", "--json"], { cwd: dir, timeoutMs: 60_000 }).catch(() => null);
      let tagStr = "-";
      try {
        const t = JSON.parse(tags?.stdout ?? "") as Record<string, string>;
        tagStr = `latest=${t.latest ?? "-"} beta=${t.beta ?? "-"}`;
      } catch {
        /* npm absent or offline */
      }
      const help = async (args: string[], extra: Record<string, string | undefined> = {}) => {
        const r = await run([SB, ...args], { cwd: dir, env: baseEnv(extra), timeoutMs: 30_000 }).catch(() => null);
        return { code: r?.code ?? -1, compute: r && COMPUTE_RX.test(r.all) ? 1 : 0, head: (r?.all ?? "spawn failed").split("\n").slice(0, 3).join(" | ") };
      };
      const plain = await help(["compute", "--help"]);
      const envOn = await help(["compute", "--help"], { SUPABASE_EXPERIMENTAL_COMPUTE: "1" });
      const flag = await help(["--experimental", "compute", "--help"]);
      const cliList = await run([SB, "compute", "list", "--project-ref", ref], {
        cwd: dir,
        env: baseEnv({ SUPABASE_EXPERIMENTAL_COMPUTE: "1", SUPABASE_ACCESS_TOKEN: ctx.pat }),
        timeoutMs: 60_000,
      }).catch(() => null);
      out.push({
        id: "CS00h",
        title: "CLI: `supabase compute` presence and the read-only list against the project",
        status: "info",
        detail: `CLI ${ver?.stdout.trim() || "absent"}; compute help without env ${plain.compute ? "present" : "absent"}, with SUPABASE_EXPERIMENTAL_COMPUTE=1 ${envOn.compute ? "present" : "absent"}, with --experimental ${flag.compute ? "present" : "absent"}; compute list exit ${cliList?.code ?? -1}`,
        measurements: {
          cli_version: ver?.stdout.trim() || "absent",
          npm_dist_tags: tagStr,
          help_plain_compute: plain.compute,
          help_plain_exit: plain.code,
          help_env_compute: envOn.compute,
          help_env_exit: envOn.code,
          help_flag_compute: flag.compute,
          help_flag_exit: flag.code,
          compute_list_exit: cliList?.code ?? -1,
        },
        evidence: [
          `compute --help (no env): ${plain.head}`,
          `SUPABASE_EXPERIMENTAL_COMPUTE=1 compute --help: ${envOn.head}`,
          `--experimental compute --help: ${flag.head}`,
          `SUPABASE_EXPERIMENTAL_COMPUTE=1 compute list --project-ref <ref>: ${(cliList?.all ?? "spawn failed").trim().slice(0, 600)}`,
        ].join("\n"),
      });

      out.push({
        id: "CS00",
        title: "Compute gate for a new Micro project on the Pro organization",
        status: "info",
        detail: `gate ${gate}: ${routes.join("; ")}`,
        measurements: { gate, routes: routes.join("; ") },
      });
    } catch (e) {
      out.push({ id: "CS00", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const st = ref ? await dropProject(ctx, ref) : 0;
      out.push({ id: "CS00z", title: "cleanup", status: ref ? (st < 300 || st === 404 ? "pass" : "fail") : "info", detail: ref ? `DELETE project HTTP ${st}` : "no project created" });
    }
    return out;
  },
};
export default mod;
