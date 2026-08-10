/**
 * G02 - PDF text extraction inside an Edge Function, and where it stops.
 *
 * The platform ships no PDF product - that much is a documentation fact, not
 * an interesting one. The question this test answers is whether the
 * CUSTOMER-OWNED extraction step (PDF -> text) can run on the platform's own
 * Deno Edge Runtime at all, and, walking the fixture corpus ascending by
 * size, exactly where and how it stops. `../functions/pdf-extract/index.ts`
 * is the function under test; this file deploys it (idempotently, via the
 * `supabase` CLI's `--use-api` path so no Docker is required) and invokes it
 * once per fixture.
 *
 * WHAT COUNTS AS A FINDING HERE. Every outcome - success at every fixture
 * size, or a failure at some point - is recorded as `info` with a
 * measurement, never asserted as pass/fail. The ceiling (the largest fixture
 * that survives) and the shape of the first failure are the deliverable, and
 * neither has a "correct" value to check against.
 *
 * CLASSIFYING THE FAILURE. The deployed function returns structured JSON
 * (`{ ok: false, stage, error }`) for every failure it can see itself: a
 * fixture fetch that 404s, an extraction exception. A failure the function
 * canNOT see - the isolate killed mid-request for CPU time, memory, or a
 * boot/bundle problem - shows up to THIS caller as something else: a non-2xx
 * with a body that isn't the function's own JSON contract, or the caller's
 * own fetch timing out or the connection dropping. `invoke()` below
 * classifies from those externally-visible signals (status code, response
 * text, client-side abort) rather than assuming which one the platform will
 * report, because assuming that is exactly the kind of expected-answer bias
 * GUIDE.md warns against.
 *
 * IF DEPLOYMENT ITSELF IS IMPOSSIBLE. No CLI on PATH, no PAT, or a deploy
 * command that fails outright - this test records the failure and SKIPS with
 * a reason rather than fabricating extraction results. That is a legitimate,
 * different finding from "extraction stops at fixture N" and must not be
 * conflated with it.
 */
import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { BY_SIZE } from "../lib/fixtures";
import { instanceSize } from "../lib/pg";

const SLUG = "pdf-extract-g02";
// `process.cwd()`-relative, not `import.meta.dir`-relative - see
// lib/schema.ts's header comment for why: under `bun build --compile` (what
// scripts/live-suite.sh runs), `import.meta.dir` resolves to a virtual
// bundle path this file was never copied into, and reading it from there
// fails with ENOENT. `process.cwd()` is the experiment directory, per the
// same invocation contract `run.ts`'s own `--tests ./tests` default assumes.
const FUNCTION_SRC = join(process.cwd(), "functions", "pdf-extract", "index.ts");
// Generous outer bound on the CALLER's side. The platform's own limit is what
// this test exists to find, not to assume - this just stops the test process
// itself from hanging forever if the platform never answers.
const INVOKE_TIMEOUT_MS = 150_000;

type FailureMode = "ok" | "timeout" | "memory" | "bundle" | "upstream-fetch" | "http-error" | "network";

async function listFunctionSlugs(ctx: Ctx): Promise<{ ok: boolean; slugs: string[]; status: number }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions`);
  const arr = Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [];
  return { ok: r.status === 200, slugs: arr.map((f) => String(f.slug ?? "")), status: r.status };
}

/** Deploys via the CLI's server-side bundler (`--use-api`, no Docker) into a
 * scratch workdir outside the repo - the committed source under `functions/`
 * is copied there unmodified, so the deployed code matches what is in git. */
async function deploy(ctx: Ctx): Promise<{ ok: boolean; detail: string }> {
  const which = await $`which supabase`.quiet().nothrow();
  if (which.exitCode !== 0) {
    return { ok: false, detail: "supabase CLI not on PATH - cannot deploy an Edge Function from a test" };
  }

  const workdir = join(tmpdir(), `pvlab-g02-${crypto.randomUUID()}`);
  const destDir = join(workdir, "supabase", "functions", SLUG);
  await $`mkdir -p ${destDir}`.quiet().nothrow();
  await Bun.write(join(destDir, "index.ts"), await Bun.file(FUNCTION_SRC).text());

  const p =
    await $`supabase functions deploy ${SLUG} --project-ref ${ctx.ref} --use-api --no-verify-jwt --workdir ${workdir}`
      .env({ ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" })
      .quiet()
      .nothrow();
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  await $`rm -rf ${workdir}`.quiet().nothrow();

  return { ok: p.exitCode === 0, detail: out.slice(0, 500) || `exit ${p.exitCode}` };
}

async function invoke(
  ctx: Ctx,
  fixtureUrl: string,
): Promise<{
  mode: FailureMode;
  status: number | null;
  detail: string;
  chars?: number;
  pages?: number;
  extractMs?: number;
  fetchMs?: number;
  wallMs: number;
}> {
  const endpoint = `https://${ctx.apiHost}/functions/v1/${SLUG}?url=${encodeURIComponent(fixtureUrl)}`;
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS) });
    const wallMs = performance.now() - t0;
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = undefined; // a non-JSON body is itself part of the finding below
    }

    if (res.ok && body?.ok === true) {
      return {
        mode: "ok",
        status: res.status,
        detail: "extracted",
        chars: Number(body.extractedChars ?? 0),
        pages: Number(body.pages ?? 0),
        extractMs: Number(body.extractMs ?? 0),
        fetchMs: Number(body.fetchMs ?? 0),
        wallMs,
      };
    }

    // A failure the function itself caught and reported via its own contract.
    if (body && body.ok === false) {
      const stage = String(body.stage ?? "unknown");
      return {
        mode: stage === "fetch" ? "upstream-fetch" : "http-error",
        status: res.status,
        detail: `${stage}: ${String(body.error ?? "")}`.slice(0, 300),
        wallMs,
      };
    }

    // Unhandled: the isolate did not get to run the function's own try/catch.
    // Classify from what the EDGE RUNTIME itself returned, not from the
    // function's JSON contract, which never got a chance to run.
    const lower = text.toLowerCase();
    let mode: FailureMode = "http-error";
    if (res.status === 546 || lower.includes("memory") || lower.includes("worker_limit")) mode = "memory";
    else if (
      res.status === 504 ||
      res.status === 524 ||
      lower.includes("timeout") ||
      lower.includes("time limit")
    )
      mode = "timeout";
    else if (lower.includes("too large") || lower.includes("bundle") || lower.includes("boot error"))
      mode = "bundle";

    return { mode, status: res.status, detail: text.slice(0, 300), wallMs };
  } catch (e) {
    const wallMs = performance.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    // Our OWN fetch aborted, or the connection dropped mid-response - both
    // look, from out here, like the platform killed the isolate.
    const mode: FailureMode = /abort|timeout/i.test(msg) ? "timeout" : "network";
    return { mode, status: null, detail: msg.slice(0, 300), wallMs };
  }
}

const mod: TestModule = {
  id: "G02",
  title: "PDF text extraction inside an Edge Function, and where it stops",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref || !ctx.apiHost) {
      return [{ id: "G02", title: mod.title, status: "skip", detail: "PVLAB_REF not set - no project to deploy to" }];
    }

    const existing = await listFunctionSlugs(ctx);
    let deployNote: string;
    if (existing.ok && existing.slugs.includes(SLUG)) {
      deployNote = "reused - function already deployed";
    } else {
      const d = await deploy(ctx);
      if (!d.ok) {
        return [
          {
            id: "G02",
            title: mod.title,
            status: "skip",
            detail: `Edge Function deployment failed: ${d.detail}`,
            measurements: { instance_size: instanceSize(), functions_list_status: existing.status },
          },
        ];
      }
      deployNote = `deployed just now: ${d.detail}`;
      // Give the platform a moment to route the freshly deployed function
      // before the first invoke - an immediate call risks a cold 404 that
      // looks like a deploy failure but is actually a race with this test.
      await Bun.sleep(3000);
    }

    const results: TestResult[] = [];
    let ceilingSlug = "none - extraction failed even on the smallest fixture";
    let firstFailure = "none - every fixture extracted";

    for (const fx of BY_SIZE) {
      const r = await invoke(ctx, fx.url);
      const key = fx.slug.replace(/-/g, "_");
      const measurements: Record<string, number | string> = {
        instance_size: instanceSize(),
        source_bytes: fx.expectBytes,
        genre: fx.genre,
        mode: r.mode,
        wall_ms: Math.round(r.wallMs),
        http_status: String(r.status ?? "none"),
      };
      if (r.mode === "ok") {
        measurements.extracted_chars = r.chars ?? 0;
        measurements.pages = r.pages ?? 0;
        measurements.extract_ms = r.extractMs ?? 0;
        measurements.fetch_ms = r.fetchMs ?? 0;
        ceilingSlug = fx.slug; // BY_SIZE is ascending, so the last "ok" wins
      } else if (firstFailure.startsWith("none")) {
        firstFailure = `${fx.slug} (${fx.expectBytes}B, ${fx.genre}): ${r.mode}`;
      }

      results.push({
        id: `G02-${key}`,
        title: `Edge Function extraction: ${fx.slug} (${fx.genre}, ${fx.expectBytes}B)`,
        status: "info",
        detail: `${r.mode}: ${r.detail}`,
        measurements,
      });
    }

    results.unshift({
      id: "G02",
      title: mod.title,
      status: "info",
      detail: `${deployNote}; ceiling (largest fixture that extracted successfully): ${ceilingSlug}; first failure: ${firstFailure}`,
      measurements: {
        instance_size: instanceSize(),
        deploy: deployNote.startsWith("reused") ? "reused" : "deployed",
        fixtures_probed: BY_SIZE.length,
        ceiling: ceilingSlug,
        first_failure: firstFailure,
      },
    });

    return results;
  },
};

export default mod;
