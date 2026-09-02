/**
 * EF06 - restrictions that are not size or count limits.
 *
 * They sit below the limits tables on the same docs page and two of them
 * break deploys outright. Each is a small function deployed for the purpose,
 * with the runtime's own error text recorded verbatim.
 *
 *   EF06a  HTML: a GET returning text/html on the project hostname is
 *          rewritten to text/plain (custom domains excepted - not probed here)
 *   EF06b  outbound ports 25 and 587 are blocked; 443 is the control
 *   EF06c  Web Worker and node:vm are unavailable
 *   EF06d  static files via the API deploy path: the docs say they cannot
 *          be deployed with the API flag; the contract declares
 *          static_patterns (EF01c) - which is true at runtime?
 *   EF06d2 the positive control: static_files through the CLI's local
 *          bundling, which is the documented working path
 *   EF06e  a multithreaded Node library (sharp) - deploys? runs?
 *
 * DESTRUCTIVE: deploys under pvlab-ef06-, deletes in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { BLOCKED_PORTS } from "../lib/docs";
import { cleanupPrefix, cliDeploy, cliVersion, deployViaApi, dockerAvailable, invokeWhenLive } from "../lib/ef";

const P = "pvlab-ef06-";
const meta = (slug: string, extra: Record<string, unknown> = {}) => ({ entrypoint_path: "index.ts", name: slug, verify_jwt: false, ...extra });

const HTML_SRC = `Deno.serve(() => new Response("<h1>pvlab</h1>", { headers: { "Content-Type": "text/html; charset=utf-8" } }));\n`;

const PORTS_SRC = `
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const hostname = u.searchParams.get("host") ?? "example.com";
  const port = Number(u.searchParams.get("port") ?? "443");
  const t0 = Date.now();
  try {
    const conn = await Promise.race([
      Deno.connect({ hostname, port }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("pvlab-timeout-8000ms")), 8000)),
    ]);
    (conn as Deno.Conn).close();
    return Response.json({ ok: true, hostname, port, ms: Date.now() - t0 });
  } catch (e) {
    return Response.json({ ok: false, hostname, port, ms: Date.now() - t0, error: String(e).slice(0, 300) });
  }
});
`;

const APIS_SRC = `
Deno.serve(async () => {
  const out: Record<string, unknown> = { workerType: typeof Worker };
  try {
    const url = URL.createObjectURL(new Blob(["self.postMessage(1)"], { type: "application/javascript" }));
    const w = new Worker(url, { type: "module" });
    out.workerConstruct = "ok";
    w.terminate();
  } catch (e) {
    out.workerConstruct = String(e).slice(0, 200);
  }
  try {
    const vm = await import("node:vm");
    out.vmImport = "ok";
    out.vmRun = String(vm.runInNewContext("1+1"));
  } catch (e) {
    out.vmImport = String(e).slice(0, 200);
  }
  return Response.json(out);
});
`;

const STATIC_SRC = `
Deno.serve(async () => {
  try {
    const text = await Deno.readTextFile(new URL("./static/hello.txt", import.meta.url));
    return Response.json({ ok: true, text: text.trim() });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
});
`;

const SHARP_SRC = `
import sharp from "npm:sharp";
Deno.serve(async () => {
  try {
    const buf = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    return Response.json({ ok: true, bytes: buf.length });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
});
`;

function parse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

const mod: TestModule = {
  id: "EF06",
  title: "Documented restrictions at runtime (HTML, ports, APIs, static files, multithreaded libs)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF06", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    try {
      await cleanupPrefix(ctx, P);

      // ---- EF06a: HTML rewrite ----
      {
        const slug = `${P}html`;
        const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: HTML_SRC }], meta(slug));
        const get = await invokeWhenLive(ctx, slug);
        const post = await invokeWhenLive(ctx, slug, 30_000, { method: "POST", body: {} });
        const rewritten = /^text\/plain/i.test(get.contentType);
        out.push({
          id: "EF06a",
          title: "GET returning text/html is rewritten to text/plain on the project hostname",
          status: dep.status < 300 && get.status === 200 ? (rewritten ? "pass" : "fail") : "fail",
          detail:
            dep.status >= 300
              ? `deploy HTTP ${dep.status} "${dep.error}"`
              : `GET -> ${get.status} ${get.contentType || "(no content-type)"}; POST -> ${post.status} ${post.contentType || "(none)"}`,
          measurements: {
            deploy_status: dep.status,
            get_status: get.status,
            get_content_type: get.contentType || "none",
            post_status: post.status,
            post_content_type: post.contentType || "none",
            rewritten_to_plain: rewritten ? 1 : 0,
          },
        });
      }

      // ---- EF06b: blocked ports ----
      {
        const slug = `${P}ports`;
        const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: PORTS_SRC }], meta(slug));
        const probe = async (host: string, port: number) => {
          const r = await invokeWhenLive(ctx, slug, 60_000, { path: `?host=${host}&port=${port}`, timeoutMs: 30_000 });
          const j = parse(r.text);
          return { status: r.status, ok: j.ok === true, error: String(j.error ?? ""), ms: Number(j.ms ?? 0) };
        };
        const control = await probe("example.com", 443);
        const blocked = await Promise.all(BLOCKED_PORTS.map((p) => probe("smtp.gmail.com", p)));
        const p465 = await probe("smtp.gmail.com", 465);
        const holds = control.ok && blocked.every((b) => !b.ok);
        out.push({
          id: "EF06b",
          title: `outbound ports ${BLOCKED_PORTS.join(" and ")} blocked, 443 open`,
          status: dep.status < 300 ? (holds ? "pass" : "fail") : "fail",
          detail:
            dep.status >= 300
              ? `deploy HTTP ${dep.status} "${dep.error}"`
              : `443 ${control.ok ? "ok" : `FAILED "${control.error}"`}; ` +
                blocked.map((b, i) => `${BLOCKED_PORTS[i]} ${b.ok ? "OPEN" : `blocked "${b.error}"`}`).join("; ") +
                `; 465 (undocumented) ${p465.ok ? "open" : `blocked "${p465.error}"`}`,
          measurements: {
            deploy_status: dep.status,
            port_443_ok: control.ok ? 1 : 0,
            port_25_ok: blocked[0]?.ok ? 1 : 0,
            port_25_error: blocked[0]?.error || "none",
            port_25_ms: blocked[0]?.ms ?? 0,
            port_587_ok: blocked[1]?.ok ? 1 : 0,
            port_587_error: blocked[1]?.error || "none",
            port_587_ms: blocked[1]?.ms ?? 0,
            port_465_ok: p465.ok ? 1 : 0,
            port_465_error: p465.error || "none",
          },
        });
      }

      // ---- EF06c: unavailable APIs ----
      {
        const slug = `${P}apis`;
        const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: APIS_SRC }], meta(slug));
        const r = await invokeWhenLive(ctx, slug);
        const j = parse(r.text);
        const workerUnavailable = j.workerType === "undefined" || (typeof j.workerConstruct === "string" && j.workerConstruct !== "ok");
        const vmUnavailable = j.vmImport !== "ok" || j.vmRun !== "2";
        out.push({
          id: "EF06c",
          title: "Web Worker and node:vm unavailable",
          status: dep.status < 300 && r.status === 200 ? (workerUnavailable && vmUnavailable ? "pass" : "fail") : "fail",
          detail:
            dep.status >= 300
              ? `deploy HTTP ${dep.status} "${dep.error}"`
              : `typeof Worker=${String(j.workerType)}, construct=${String(j.workerConstruct)}; vm import=${String(j.vmImport)}${j.vmRun ? `, run=${String(j.vmRun)}` : ""}`,
          measurements: {
            deploy_status: dep.status,
            invoke_status: r.status,
            worker_typeof: String(j.workerType ?? "?"),
            worker_construct: String(j.workerConstruct ?? "?").slice(0, 120),
            vm_import: String(j.vmImport ?? "?").slice(0, 120),
            vm_run: String(j.vmRun ?? "n/a"),
            worker_unavailable: workerUnavailable ? 1 : 0,
            vm_unavailable: vmUnavailable ? 1 : 0,
          },
        });
      }

      // ---- EF06d: static files via the API ----
      {
        const slug = `${P}static-api`;
        const dep = await deployViaApi(
          ctx,
          slug,
          [
            { name: "index.ts", content: STATIC_SRC },
            { name: "static/hello.txt", content: "hello-from-static\n" },
          ],
          meta(slug, { static_patterns: ["static/**"] }),
        );
        const r = dep.status < 300 ? await invokeWhenLive(ctx, slug) : undefined;
        const j = r ? parse(r.text) : {};
        const served = r?.status === 200 && j.ok === true;
        out.push({
          id: "EF06d",
          title: "static file deployed through the API path (docs: cannot)",
          // The docs claim a restriction; "pass" means the restriction holds.
          status: served ? "fail" : "pass",
          detail:
            dep.status >= 300
              ? `deploy refused HTTP ${dep.status} "${dep.error}" - the restriction bites at deploy time`
              : served
                ? `deploy ${dep.status} AND the file is readable at runtime ("${String(j.text)}") - the docs' restriction did not hold`
                : `deploy ${dep.status} but the read fails at runtime: ${r?.status} "${String(j.error ?? j.raw ?? "")}" - the deploy reports success and the asset is missing`,
          measurements: {
            deploy_status: dep.status,
            deploy_error: dep.error || "none",
            invoke_status: r?.status ?? "n/a",
            file_readable: served ? 1 : 0,
            runtime_error: String(j.error ?? "none").slice(0, 160),
          },
        });
      }

      // ---- EF06d2: static files via CLI local bundling (positive control) ----
      {
        const cli = await cliVersion();
        const docker = await dockerAvailable();
        const slug = `${P}static-cli`;
        if (cli === "absent" || !docker) {
          out.push({ id: "EF06d2", title: "static file via CLI local bundling", status: "skip", detail: cli === "absent" ? "supabase CLI not on PATH" : "docker unavailable" });
        } else {
          // Paths in static_files are relative to the supabase/ directory
          // ("./functions/<name>/..." per the CLI config reference); the first
          // run used "./supabase/functions/..." and bundled a 654 B script with
          // no asset, which is the silent way a wrong glob fails.
          const config = `project_id = "pvlab"\n\n[functions.${slug}]\nstatic_files = ["./functions/${slug}/static/*"]\n`;
          const res = await cliDeploy(
            ctx,
            [{ slug, files: [{ name: "index.ts", content: STATIC_SRC }, { name: "static/hello.txt", content: "hello-from-static\n" }] }],
            { rootFiles: [{ name: "supabase/config.toml", content: config }] },
          );
          const r = res.exitCode === 0 ? await invokeWhenLive(ctx, slug) : undefined;
          const j = r ? parse(r.text) : {};
          const served = r?.status === 200 && j.ok === true;
          out.push({
            id: "EF06d2",
            title: "static file via CLI local bundling (the documented working path)",
            status: served ? "pass" : "fail",
            detail:
              res.exitCode !== 0
                ? `CLI exit ${res.exitCode}: "${res.error}"`
                : served
                  ? `exit 0, file readable at runtime ("${String(j.text)}")`
                  : `exit 0 but runtime read ${r?.status}: "${String(j.error ?? j.raw ?? "")}"`,
            measurements: {
              cli_version: cli,
              exit_code: res.exitCode,
              invoke_status: r?.status ?? "n/a",
              file_readable: served ? 1 : 0,
              error: res.error || String(j.error ?? "none").slice(0, 160),
            },
            evidence: `${res.command}\n${(res.stderr || res.stdout).slice(-600)}`,
          });
        }
      }

      // ---- EF06e: multithreaded Node library ----
      {
        const slug = `${P}sharp`;
        const dep = await deployViaApi(ctx, slug, [{ name: "index.ts", content: SHARP_SRC }], meta(slug), 300_000);
        const r = dep.status < 300 ? await invokeWhenLive(ctx, slug, 90_000, { timeoutMs: 60_000 }) : undefined;
        const j = r ? parse(r.text) : {};
        const works = r?.status === 200 && j.ok === true;
        out.push({
          id: "EF06e",
          title: "npm:sharp (requires multithreading; docs: not supported)",
          status: works ? "fail" : "pass",
          detail:
            dep.status >= 300
              ? `deploy refused HTTP ${dep.status} "${dep.error}" - fails at bundle time`
              : works
                ? `deploy ${dep.status} and sharp produced a ${String(j.bytes)}-byte PNG - the docs' restriction did not hold`
                : `deploy ${dep.status}, invoke ${r?.status}: "${String(j.error ?? j.raw ?? r?.error ?? "")}" - fails at run time`,
          measurements: {
            deploy_status: dep.status,
            deploy_ms: dep.ms,
            deploy_error: dep.error || "none",
            invoke_status: r?.status ?? "n/a",
            works: works ? 1 : 0,
            runtime_error: String(j.error ?? r?.error ?? "none").slice(0, 200),
          },
        });
      }
    } catch (e) {
      out.push({ id: "EF06", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({
        id: "EF06z",
        title: "cleanup: delete pvlab-ef06-* functions",
        status: c.left.length ? "fail" : "pass",
        detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`,
        measurements: { deleted: c.deleted, left: c.left.length },
      });
    }
    return out;
  },
};
export default mod;
