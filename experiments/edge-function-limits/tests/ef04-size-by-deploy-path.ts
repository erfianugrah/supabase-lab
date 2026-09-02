/**
 * EF04 - function size is set by WHERE BUNDLING HAPPENS, not by plan.
 *
 * The same bundle goes down each path, and the report says which path took
 * it. Every "accepted" is proven from the outside: GET /functions/{slug}
 * finds it AND an invocation returns the payload length, because a deploy
 * status is not the deployed state (EF05 is about exactly that).
 *
 *   EF04a  API,  2 MB  control - inside every ceiling; must land
 *   EF04b  API,  8 MB  over the server-side ceiling (docs: 5 MB) - refused,
 *                      with the error verbatim and its triage bucket
 *   EF04c  CLI --use-api, 8 MB  same path by construction - refused
 *   EF04d  CLI default,  8 MB  local bundling (docs: 20 MB) - lands
 *   EF04e  CLI default, 24 MB  over the local ceiling - refused
 *   EF04f  CLI --use-docker, 8 MB  only if EF04d did NOT land: tells whether
 *                      this CLI version's default was the API path
 *
 * Sources are random base64 in a string literal so no bundler can shrink
 * them; the handler returns the literal's length so the invocation proves
 * which bundle is live.
 *
 * DESTRUCTIVE: deploys under pvlab-ef04-, deletes in finally. Needs the
 * supabase CLI on PATH; Docker for the local-bundling rows (they skip with a
 * reason otherwise).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { DOCS_READ_AT, FUNCTION_SIZE_MB } from "../lib/docs";
import {
  type ApiDeployResult,
  bigSource,
  cleanupPrefix,
  cliDeploy,
  type CliDeployResult,
  cliVersion,
  deployViaApi,
  dockerAvailable,
  invokeWhenLive,
  landedPatiently,
} from "../lib/ef";
import { triage } from "../lib/triage";

const P = "pvlab-ef04-";
const MB = 1024 * 1024;
const SIZES = { control: 2 * MB, overApi: 8 * MB, overCli: 24 * MB } as const;

async function prove(ctx: Ctx, slug: string): Promise<{ present: boolean; invokeStatus: number; bytes: number | string }> {
  const l = await landedPatiently(ctx, slug);
  if (!l.present) return { present: false, invokeStatus: 0, bytes: "n/a" };
  const inv = await invokeWhenLive(ctx, slug, 120_000, { timeoutMs: 60_000 });
  let bytes: number | string = "unparsed";
  try {
    bytes = Number((JSON.parse(inv.text) as { bytes?: number }).bytes ?? "unparsed");
  } catch {
    bytes = inv.error ?? inv.text.slice(0, 60);
  }
  return { present: true, invokeStatus: inv.status, bytes };
}

function apiRow(
  id: string,
  title: string,
  size: number,
  expectLand: boolean,
  dep: ApiDeployResult,
  proof: Awaited<ReturnType<typeof prove>>,
): TestResult {
  const landedLive = proof.present && proof.invokeStatus === 200;
  const t = triage({ status: dep.status, errorText: dep.error, parallel: 1, landed: proof.present });
  const ok = expectLand ? dep.status < 300 && landedLive : dep.status >= 400 && !proof.present;
  return {
    id,
    title,
    status: ok ? "pass" : "fail",
    detail: expectLand
      ? landedLive
        ? `HTTP ${dep.status}, landed, invoke 200 reports ${proof.bytes} bytes`
        : `HTTP ${dep.status}${dep.error ? ` "${dep.error}"` : ""}; present=${proof.present} invoke=${proof.invokeStatus}`
      : dep.status >= 400
        ? `refused HTTP ${dep.status}: "${dep.error}" [${t.bucket}]${proof.present ? " - BUT the function is present afterwards" : ""}`
        : `ACCEPTED HTTP ${dep.status} at ${Math.round(size / MB)} MB - the documented ${FUNCTION_SIZE_MB.api} MB server-side ceiling did not bite; landed=${proof.present} invoke=${proof.invokeStatus}`,
    measurements: {
      path: "api",
      size_mb: Math.round(size / MB),
      docs_ceiling_mb: FUNCTION_SIZE_MB.api,
      deploy_status: dep.status,
      deploy_ms: dep.ms,
      error: dep.error || "none",
      present_after: proof.present ? 1 : 0,
      invoke_status: proof.invokeStatus,
      bytes_reported: proof.bytes,
      triage_bucket: t.bucket,
    },
    evidence: dep.status >= 300 ? dep.text.slice(0, 600) : undefined,
  };
}

function cliRow(
  id: string,
  title: string,
  size: number,
  expectLand: boolean,
  ceiling: number,
  res: CliDeployResult,
  proof: Awaited<ReturnType<typeof prove>>,
): TestResult {
  const landedLive = proof.present && proof.invokeStatus === 200;
  const t = triage({ exitCode: res.exitCode, errorText: res.error, parallel: 1, landed: proof.present });
  const ok = expectLand ? res.exitCode === 0 && landedLive : res.exitCode !== 0 && !proof.present;
  return {
    id,
    title,
    status: ok ? "pass" : "fail",
    detail: expectLand
      ? landedLive
        ? `exit ${res.exitCode}, landed, invoke 200 reports ${proof.bytes} bytes in ${Math.round(res.ms / 1000)}s`
        : `exit ${res.exitCode}${res.error ? ` "${res.error}"` : ""}; present=${proof.present} invoke=${proof.invokeStatus} [${t.bucket}]`
      : res.exitCode !== 0
        ? `refused exit ${res.exitCode}: "${res.error}" [${t.bucket}]${proof.present ? " - BUT the function is present afterwards" : ""}`
        : `exit 0 at ${Math.round(size / MB)} MB - the documented ${ceiling} MB ceiling did not bite; landed=${proof.present} invoke=${proof.invokeStatus}`,
    measurements: {
      path: title.includes("--use-api") ? "cli-use-api" : title.includes("--use-docker") ? "cli-use-docker" : "cli-default",
      size_mb: Math.round(size / MB),
      docs_ceiling_mb: ceiling,
      exit_code: res.exitCode,
      deploy_ms: res.ms,
      error: res.error || "none",
      present_after: proof.present ? 1 : 0,
      invoke_status: proof.invokeStatus,
      bytes_reported: proof.bytes,
      stderr_mentions_docker: /docker/i.test(res.stderr) ? 1 : 0,
      triage_bucket: t.bucket,
    },
    evidence: `${res.command}\n--- stdout\n${res.stdout.slice(0, 800)}\n--- stderr\n${res.stderr.slice(-800)}`,
  };
}

const mod: TestModule = {
  id: "EF04",
  title: "Function size ceiling by deploy path (server-side vs local bundling)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF04", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const cli = await cliVersion();
    const docker = await dockerAvailable();
    const meta = (slug: string) => ({ entrypoint_path: "index.ts", name: slug, verify_jwt: false });
    try {
      await cleanupPrefix(ctx, P);

      // EF04a - API control.
      {
        const slug = `${P}api-2mb`;
        const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: bigSource(SIZES.control) }], meta(slug));
        out.push(apiRow("EF04a", "API deploy, 2 MB (control)", SIZES.control, true, dep, await prove(ctx, slug)));
      }
      // EF04b - API over the server-side ceiling.
      {
        const slug = `${P}api-8mb`;
        const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: bigSource(SIZES.overApi) }], meta(slug));
        out.push(apiRow("EF04b", "API deploy, 8 MB (over the server-side ceiling)", SIZES.overApi, false, dep, await prove(ctx, slug)));
      }

      if (cli === "absent") {
        for (const id of ["EF04c", "EF04d", "EF04e"]) out.push({ id, title: id, status: "skip", detail: "supabase CLI not on PATH" });
        return out;
      }

      // EF04c - CLI on the API path is the same ceiling by construction.
      {
        const slug = `${P}cli-api-8mb`;
        const res = await cliDeploy(ctx, [{ slug, files: [{ name: "index.ts", content: bigSource(SIZES.overApi) }] }], { bundling: "use-api" });
        out.push(cliRow("EF04c", "CLI --use-api, 8 MB", SIZES.overApi, false, FUNCTION_SIZE_MB.api, res, await prove(ctx, slug)));
      }

      if (!docker) {
        for (const id of ["EF04d", "EF04e"]) out.push({ id, title: id, status: "skip", detail: "docker unavailable - local bundling rows need it" });
        return out;
      }

      // EF04d - CLI default at 8 MB.
      let defaultLanded = false;
      {
        const slug = `${P}cli-def-8mb`;
        const res = await cliDeploy(ctx, [{ slug, files: [{ name: "index.ts", content: bigSource(SIZES.overApi) }] }]);
        const proof = await prove(ctx, slug);
        defaultLanded = proof.present && proof.invokeStatus === 200;
        out.push(cliRow("EF04d", "CLI default bundling, 8 MB", SIZES.overApi, true, FUNCTION_SIZE_MB.cli, res, proof));
      }
      // EF04e - CLI default at 24 MB.
      {
        const slug = `${P}cli-def-24mb`;
        const res = await cliDeploy(ctx, [{ slug, files: [{ name: "index.ts", content: bigSource(SIZES.overCli) }] }]);
        out.push(cliRow("EF04e", "CLI default bundling, 24 MB (over the local ceiling)", SIZES.overCli, false, FUNCTION_SIZE_MB.cli, res, await prove(ctx, slug)));
      }
      // EF04f - only informative if the default did not behave like local bundling.
      if (!defaultLanded) {
        const slug = `${P}cli-docker-8mb`;
        const res = await cliDeploy(ctx, [{ slug, files: [{ name: "index.ts", content: bigSource(SIZES.overApi) }] }], { bundling: "use-docker" });
        out.push(cliRow("EF04f", "CLI --use-docker, 8 MB (default did not land)", SIZES.overApi, true, FUNCTION_SIZE_MB.cli, res, await prove(ctx, slug)));
      }
    } catch (e) {
      out.push({ id: "EF04", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({
        id: "EF04z",
        title: "cleanup: delete pvlab-ef04-* functions",
        status: c.left.length ? "fail" : "pass",
        detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`,
        measurements: { deleted: c.deleted, left: c.left.length, cli_version: cli, docker: docker ? 1 : 0, docs_read_at: DOCS_READ_AT },
      });
    }
    return out;
  },
};
export default mod;
