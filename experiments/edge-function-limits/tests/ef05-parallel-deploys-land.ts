/**
 * EF05 - when it is not a limit at all: parallel deploys, and whether the
 * functions actually landed.
 *
 * Limits reject deterministically with a named error. Deploys that break
 * intermittently, or report success and turn out not to have happened, point
 * somewhere else. This module drives the shapes that get misreported as
 * quota problems and records, for every deploy, BOTH what was reported and
 * what GET /functions/{slug} says afterwards.
 *
 *   EF05a  24 API deploys, 8 in flight: status histogram (201/409/413/429),
 *          reported successes vs landed, silent losses (2xx then 404)
 *   EF05b  8 concurrent CLI PROCESSES x 3 functions each (the shape a public
 *          CLI issue reports): exit codes vs landed, exit-0-but-missing
 *   EF05c  same-slug race: 3 rounds of 2 concurrent deploys of ONE slug -
 *          does the recorded version ever move backwards, and does the
 *          function still answer afterwards
 *   EF05d  delete while a deploy is in flight - what state is left
 *
 * Every failure is run through `triage()` so a 413 under parallelism is
 * labelled misleading-413 and a 429 is labelled throttled, not "limit".
 * A 409 is kept separate from a 429 throughout.
 *
 * DESTRUCTIVE: deploys under pvlab-ef05-, deletes in finally. Deliberately
 * provokes the control-plane rate limit; cleanup and verification reads
 * retry through it.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  type ApiDeployResult,
  cleanupPrefix,
  cliDeploy,
  cliVersion,
  deployViaApi,
  invokeWhenLive,
  landedPatiently,
  tinySource,
} from "../lib/ef";
import { type Bucket, triage } from "../lib/triage";

const P = "pvlab-ef05-";
const N = 24;
const PAR = 8;

function histogram(values: (number | string)[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([k, n]) => `${k}:${n}`)
    .join("|");
}

async function inWaves<T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += width) {
    out.push(...(await Promise.all(items.slice(i, i + width).map(fn))));
  }
  return out;
}

const meta = (slug: string) => ({ entrypoint_path: "index.ts", name: slug, verify_jwt: false });

const mod: TestModule = {
  id: "EF05",
  title: "Parallel deploys: reported success vs functions that actually landed",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF05", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    try {
      await cleanupPrefix(ctx, P);

      // ---- EF05a: API deploys, PAR in flight ----
      {
        const slugs = Array.from({ length: N }, (_, i) => `${P}api-${String(i).padStart(2, "0")}`);
        const deps = await inWaves(slugs, PAR, (slug) =>
          deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(slug) }], meta(slug), 120_000),
        );
        const present: boolean[] = [];
        for (const slug of slugs) present.push((await landedPatiently(ctx, slug)).present);
        const reportedOk = deps.filter((d) => d.status < 300).length;
        const landedN = present.filter(Boolean).length;
        const silentLoss = deps.filter((d, i) => d.status < 300 && !present[i]).length;
        const failedButPresent = deps.filter((d, i) => d.status >= 300 && present[i]).length;
        const buckets: Bucket[] = deps
          .map((d, i) => (d.status >= 300 ? triage({ status: d.status, errorText: d.error, parallel: PAR, landed: present[i] }).bucket : null))
          .filter((b): b is Bucket => b !== null);
        const firstErrors = [...new Set(deps.filter((d) => d.status >= 300).map((d) => `${d.status} ${d.error}`))].slice(0, 4);
        out.push({
          id: "EF05a",
          title: `${N} API deploys, ${PAR} in flight: reported vs landed`,
          status: silentLoss === 0 ? "pass" : "fail",
          detail:
            `${reportedOk}/${N} reported 2xx, ${landedN}/${N} present afterwards, ${silentLoss} silent loss` +
            (failedButPresent ? `, ${failedButPresent} failed-but-present` : "") +
            (buckets.length ? `; failures: ${histogram(buckets)}` : "; no failures"),
          measurements: {
            n: N,
            parallel: PAR,
            reported_2xx: reportedOk,
            landed: landedN,
            silent_loss: silentLoss,
            failed_but_present: failedButPresent,
            status_histogram: histogram(deps.map((d) => d.status)),
            triage_histogram: histogram(buckets) || "none",
            n_429: deps.filter((d) => d.status === 429).length,
            n_409: deps.filter((d) => d.status === 409).length,
            n_413: deps.filter((d) => d.status === 413).length,
            html_interstitials: deps.filter((d) => d.throttled).length,
            p50_deploy_ms: [...deps.map((d) => d.ms)].sort((a, b) => a - b)[Math.floor(deps.length / 2)] ?? 0,
          },
          evidence: firstErrors.join("\n") || undefined,
        });
      }

      // ---- EF05b: concurrent CLI processes ----
      const cli = await cliVersion();
      if (cli === "absent") {
        out.push({ id: "EF05b", title: "concurrent CLI processes", status: "skip", detail: "supabase CLI not on PATH" });
      } else {
        const groups = Array.from({ length: PAR }, (_, g) =>
          Array.from({ length: N / PAR }, (_, k) => `${P}cli-${g}-${k}`),
        );
        // --use-api keeps this about the control plane rather than about eight
        // Docker bundles contending for one machine; the reported shape ran
        // the CLI's default, so record the flag with the result.
        const runs = await Promise.all(
          groups.map((slugs) =>
            cliDeploy(
              ctx,
              slugs.map((slug) => ({ slug, files: [{ name: "index.ts", content: tinySource(slug) }] })),
              { bundling: "use-api", timeoutMs: 600_000 },
            ),
          ),
        );
        const all = groups.flat();
        const present = new Map<string, boolean>();
        for (const slug of all) present.set(slug, (await landedPatiently(ctx, slug)).present);
        const exit0 = runs.filter((r) => r.exitCode === 0).length;
        const exit0Missing = groups.reduce(
          (acc, slugs, g) => acc + (runs[g]?.exitCode === 0 ? slugs.filter((s) => !present.get(s)).length : 0),
          0,
        );
        const landedN = all.filter((s) => present.get(s)).length;
        const throttleMentions = runs.filter((r) => /429|ThrottlerException|Too Many Requests/i.test(r.stdout + r.stderr)).length;
        const buckets = runs
          .filter((r) => r.exitCode !== 0)
          .map((r) => triage({ exitCode: r.exitCode, errorText: r.error, parallel: PAR }).bucket);
        out.push({
          id: "EF05b",
          title: `${PAR} concurrent CLI processes x ${N / PAR} functions: exit codes vs landed`,
          status: exit0Missing === 0 ? "pass" : "fail",
          detail:
            `${exit0}/${PAR} processes exited 0, ${landedN}/${N} functions present, ${exit0Missing} exit-0-but-missing` +
            (throttleMentions ? `; ${throttleMentions} process(es) surfaced a 429` : "; no 429 surfaced") +
            (buckets.length ? `; non-zero exits: ${histogram(buckets)}` : ""),
          measurements: {
            cli_version: cli,
            bundling_flag: "--use-api",
            processes: PAR,
            functions_per_process: N / PAR,
            exit0_processes: exit0,
            landed: landedN,
            exit0_but_missing: exit0Missing,
            exit_histogram: histogram(runs.map((r) => r.exitCode)),
            processes_with_429_text: throttleMentions,
            max_process_ms: Math.max(...runs.map((r) => r.ms)),
          },
          evidence: runs
            .map((r, g) => `[proc ${g}] exit ${r.exitCode} ${Math.round(r.ms / 1000)}s\n${(r.stderr || r.stdout).slice(-300)}`)
            .join("\n"),
        });
      }

      // ---- EF05c: same-slug race ----
      {
        const slug = `${P}race`;
        const first = await deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource("v0") }], meta(slug));
        const versions: (number | string)[] = [first.version ?? (await landedPatiently(ctx, slug)).version ?? "?"];
        const statuses: number[] = [];
        let regressed = 0;
        for (let round = 1; round <= 3; round++) {
          const pair: ApiDeployResult[] = await Promise.all([
            deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(`r${round}a`) }], meta(slug)),
            deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(`r${round}b`) }], meta(slug)),
          ]);
          statuses.push(...pair.map((p) => p.status));
          const now = (await landedPatiently(ctx, slug)).version ?? "?";
          const prev = versions[versions.length - 1];
          if (typeof now === "number" && typeof prev === "number" && now < prev) regressed++;
          versions.push(now);
        }
        const after = await invokeWhenLive(ctx, slug, 60_000);
        out.push({
          id: "EF05c",
          title: "same-slug race: 3 rounds of 2 concurrent deploys",
          status: regressed === 0 && after.status === 200 ? "pass" : "fail",
          detail:
            `versions ${versions.join(" -> ")}; ${regressed} regression(s); statuses ${histogram(statuses)}; ` +
            `invoke afterwards ${after.status}${after.status !== 200 ? ` (function ${after.status === 404 ? "404s - metadata corrupted" : "unhealthy"})` : ""}`,
          measurements: {
            first_deploy_status: first.status,
            versions: versions.join(">"),
            version_regressions: regressed,
            race_status_histogram: histogram(statuses),
            n_409: statuses.filter((s) => s === 409).length,
            n_429: statuses.filter((s) => s === 429).length,
            invoke_after: after.status,
          },
        });
      }

      // ---- EF05d: delete during deploy ----
      {
        const slug = `${P}delrace`;
        await deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource("seed") }], meta(slug));
        const [dep, del] = await Promise.all([
          deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource("racing") }], meta(slug)),
          (async () => {
            await Bun.sleep(150);
            return mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${slug}`);
          })(),
        ]);
        const l = await landedPatiently(ctx, slug);
        const inv = l.present ? await invokeWhenLive(ctx, slug, 30_000) : undefined;
        out.push({
          id: "EF05d",
          title: "delete while a deploy of the same slug is in flight",
          status: "info",
          detail:
            `deploy ${dep.status}${dep.error ? ` "${dep.error}"` : ""}, delete ${del.status}; afterwards GET ${l.status}` +
            (l.present ? `, status=${l.fnStatus ?? "?"}, invoke ${inv?.status}` : " (absent)"),
          measurements: {
            deploy_status: dep.status,
            delete_status: del.status,
            present_after: l.present ? 1 : 0,
            fn_status_after: l.fnStatus ?? "absent",
            invoke_after: inv?.status ?? "n/a",
          },
        });
      }
    } catch (e) {
      out.push({ id: "EF05", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({
        id: "EF05z",
        title: "cleanup: delete pvlab-ef05-* functions",
        status: c.left.length ? "fail" : "pass",
        detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`,
        measurements: { deleted: c.deleted, left: c.left.length },
      });
    }
    return out;
  },
};
export default mod;
