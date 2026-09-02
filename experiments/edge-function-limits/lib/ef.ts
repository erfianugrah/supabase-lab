/**
 * Edge Function plumbing shared by the destructive modules: the two deploy
 * paths (Management API multipart, and the CLI with its bundling flags),
 * the "did it actually land" read, invocation, and cleanup.
 *
 * Two rules the helpers enforce so the modules cannot forget them:
 *
 *  - A deploy is never "done" on its status code or exit code. `landed()`
 *    reads GET /functions/{slug} afterwards, because a public CLI issue
 *    (supabase/cli#6247) reports exit 0 with the function absent, and this
 *    experiment exists partly to reproduce the shape of that.
 *  - Sources that have to be BIG are generated from random bytes so the
 *    bundler cannot compress them away: a size probe built from a repeated
 *    character measures the compressor, not the ceiling.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mgmt, mgmtBase } from "../../../harness/src/mgmt";
import type { Ctx } from "../../../harness/src/types";

export interface DeployFile {
  /** Path relative to the function root, e.g. "index.ts" or "static/hello.txt". */
  name: string;
  content: string | Uint8Array;
}

export interface DeployMetadata {
  entrypoint_path: string;
  name?: string;
  verify_jwt?: boolean;
  import_map_path?: string;
  static_patterns?: string[];
}

export interface ApiDeployResult {
  status: number;
  text: string;
  json?: Record<string, unknown>;
  throttled: boolean;
  ms: number;
  version?: number;
  /** Platform error text if the body carried one, verbatim. */
  error: string;
}

/** Best-effort extraction of the platform's own message from a response body. */
export function errorOf(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const nested = j.error && typeof j.error === "object" ? (j.error as Record<string, unknown>).message : undefined;
    return String(j.message ?? nested ?? j.error ?? j.msg ?? j.code ?? "").slice(0, 300);
  } catch {
    return text.trim().slice(0, 300);
  }
}

/**
 * `POST /v1/projects/{ref}/functions/deploy?slug=` - the server-side bundling
 * path. This is the path the Dashboard and the CLI's `--use-api` use, and it
 * is the path any platform deploying programmatically is on by construction.
 */
export async function deployViaApi(
  ctx: Ctx,
  slug: string,
  files: DeployFile[],
  metadata: DeployMetadata,
  timeoutMs = 180_000,
): Promise<ApiDeployResult> {
  const form = new FormData();
  for (const f of files) {
    const blob = typeof f.content === "string" ? new Blob([f.content]) : new Blob([f.content as BlobPart]);
    form.append("file", blob, f.name);
  }
  form.append("metadata", JSON.stringify({ name: slug, verify_jwt: false, ...metadata }));
  const t0 = performance.now();
  try {
    const res = await fetch(`${mgmtBase(ctx)}/projects/${ctx.ref}/functions/deploy?slug=${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.pat}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const throttled = ct.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(text);
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return {
      status: res.status,
      text,
      json,
      throttled,
      ms: Math.round(performance.now() - t0),
      version: typeof json?.version === "number" ? json.version : undefined,
      error: res.status >= 300 ? errorOf(text) : "",
    };
  } catch (e) {
    return {
      status: 0,
      text: "",
      throttled: false,
      ms: Math.round(performance.now() - t0),
      error: `ERR:${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
    };
  }
}

export interface Landed {
  status: number;
  present: boolean;
  version?: number;
  fnStatus?: string;
}

/** The read that the exit code does not replace. */
export async function landed(ctx: Ctx, slug: string): Promise<Landed> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions/${slug}`);
  const j = (r.json ?? {}) as Record<string, unknown>;
  return {
    status: r.status,
    present: r.status === 200,
    version: typeof j.version === "number" ? j.version : undefined,
    fnStatus: typeof j.status === "string" ? j.status : undefined,
  };
}

/** `landed()` with a retry on 429: a verification read must not be defeated by the throttle the deploys provoked. */
export async function landedPatiently(ctx: Ctx, slug: string): Promise<Landed> {
  let last = await landed(ctx, slug);
  for (let attempt = 0; attempt < 4 && last.status === 429; attempt++) {
    await Bun.sleep(15_000);
    last = await landed(ctx, slug);
  }
  return last;
}

export async function listSlugs(ctx: Ctx): Promise<{ status: number; slugs: string[] }> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/functions`);
  const rows = Array.isArray(r.json) ? (r.json as { slug?: string }[]) : [];
  return { status: r.status, slugs: rows.map((f) => f.slug ?? "").filter(Boolean) };
}

/** Delete with a retry on 429: cleanup must not be defeated by the throttle it just provoked. */
export async function deleteFunction(ctx: Ctx, slug: string): Promise<number> {
  let status = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${slug}`).catch(() => ({ status: 0 }));
    status = r.status;
    if (status < 300 || status === 404) return status;
    await Bun.sleep(status === 429 ? 15_000 : 2_000);
  }
  return status;
}

export interface Invocation {
  status: number;
  contentType: string;
  text: string;
  ms: number;
  error?: string;
}

export async function invoke(
  ctx: Ctx,
  slug: string,
  opts: { method?: string; path?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<Invocation> {
  const url = `https://${ctx.apiHost}/functions/v1/${slug}${opts.path ?? ""}`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(ctx.anonKey ? { apikey: ctx.anonKey, Authorization: `Bearer ${ctx.anonKey}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return {
      status: 0,
      contentType: "",
      text: "",
      ms: Math.round(performance.now() - t0),
      error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    };
  }
}

/**
 * Poll an invocation until it stops answering 404 (a fresh deploy propagates
 * over ~10 s), or until the budget runs out. Returns the last response.
 */
export async function invokeWhenLive(
  ctx: Ctx,
  slug: string,
  budgetMs = 90_000,
  opts: Parameters<typeof invoke>[2] = {},
): Promise<Invocation> {
  const t0 = Date.now();
  let last = await invoke(ctx, slug, opts);
  while (Date.now() - t0 < budgetMs && (last.status === 404 || last.status === 0)) {
    await Bun.sleep(5_000);
    last = await invoke(ctx, slug, opts);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const TINY = `Deno.serve(() => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));\n`;

export function tinySource(tag = ""): string {
  return tag ? TINY.replace("ok: true", `ok: true, tag: ${JSON.stringify(tag)}`) : TINY;
}

/**
 * A source of roughly `targetBytes` that no bundler can shrink: a string
 * literal of random base64. The handler reports the literal's length so a
 * successful deploy can be proven from the outside by invoking it.
 */
export function bigSource(targetBytes: number): string {
  const header = `const PAYLOAD = "`;
  const footer = `";\nDeno.serve(() => new Response(JSON.stringify({ bytes: PAYLOAD.length }), { headers: { "Content-Type": "application/json" } }));\n`;
  const literalLen = Math.max(0, targetBytes - header.length - footer.length);
  // base64 of n random bytes is 4n/3 chars; solve for chars directly.
  const raw = randomBytes(Math.ceil((literalLen * 3) / 4) + 3)
    .toString("base64")
    .replace(/[+/=]/g, "A");
  return header + raw.slice(0, literalLen) + footer;
}

// ---------------------------------------------------------------------------
// CLI path
// ---------------------------------------------------------------------------

export interface CliDeployResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
  /** Platform/CLI error text from stdout JSON or stderr, verbatim. */
  error: string;
  command: string;
}

export type Bundling = "default" | "use-api" | "use-docker";

export async function cliVersion(): Promise<string> {
  try {
    return (await Bun.$`supabase --version`.quiet().text()).trim().split("\n")[0] ?? "unknown";
  } catch {
    return "absent";
  }
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await Bun.$`docker info`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage a set of functions in a throwaway workdir and run one
 * `supabase functions deploy` over them. No config.toml is required - the
 * CLI resolves the project from --project-ref and the layout from --workdir
 * (checked on CLI 2.116.0). Several parallel CLI PROCESSES are modelled by
 * calling this several times concurrently, each with its own workdir, which
 * is the shape the public issue describes.
 */
export async function cliDeploy(
  ctx: Ctx,
  functions: { slug: string; files: DeployFile[] }[],
  opts: { bundling?: Bundling; jobs?: number; timeoutMs?: number; rootFiles?: DeployFile[] } = {},
): Promise<CliDeployResult> {
  const workdir = await mkdtemp(join(tmpdir(), "pvlab-ef-"));
  try {
    // Files at the workdir root - a `supabase/config.toml` when a module needs
    // per-function config such as static_files. Absent by default: the CLI
    // does not need one to deploy.
    for (const f of opts.rootFiles ?? []) {
      const p = join(workdir, f.name);
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, f.content);
    }
    for (const fn of functions) {
      const dir = join(workdir, "supabase", "functions", fn.slug);
      await mkdir(dir, { recursive: true });
      for (const f of fn.files) {
        const p = join(dir, f.name);
        await mkdir(join(p, ".."), { recursive: true });
        await writeFile(p, f.content);
      }
    }
    const args = [
      "functions",
      "deploy",
      ...functions.map((f) => f.slug),
      "--project-ref",
      ctx.ref,
      "--workdir",
      workdir,
      "--no-verify-jwt",
      "--output-format",
      "json",
    ];
    if (opts.bundling === "use-api") args.push("--use-api");
    if (opts.bundling === "use-docker") args.push("--use-docker");
    if (opts.jobs) args.push("--jobs", String(opts.jobs));
    const command = `supabase ${args.join(" ").replace(workdir, "<workdir>")}`;
    const t0 = performance.now();
    const proc = Bun.spawn(["supabase", ...args], {
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 600_000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return {
      exitCode,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000),
      ms: Math.round(performance.now() - t0),
      error: exitCode === 0 ? "" : errorOf(stdout) || stderr.trim().slice(-300),
      command,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Delete every slug with a given prefix; returns what refused to go. */
export async function cleanupPrefix(ctx: Ctx, prefix: string): Promise<{ deleted: number; left: string[] }> {
  const { slugs } = await listSlugs(ctx);
  const mine = slugs.filter((s) => s.startsWith(prefix));
  const left: string[] = [];
  for (const s of mine) {
    const st = await deleteFunction(ctx, s);
    if (!(st < 300 || st === 404)) left.push(`${s}:${st}`);
  }
  return { deleted: mine.length - left.length, left };
}
