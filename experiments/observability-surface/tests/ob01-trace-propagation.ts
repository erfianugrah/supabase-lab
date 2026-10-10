/**
 * OB01 - client trace propagation: does the `traceparent` that supabase-js
 * attaches come back as `trace_id` in the project's logs, and which releases
 * and packaging modes lose it.
 *
 * Vantage: this machine (Bun runtime, one egress to ap-southeast-1). The
 * client is a Node-style OpenTelemetry SDK (`@opentelemetry/sdk-trace-node`)
 * with the default W3C propagator. One throwaway Pro-org project holds a table
 * (`ob_probe`) and an Edge Function (`ob-echo`, verify_jwt off) that logs the
 * `traceparent` it received.
 *
 * Releases come from the npm aliases pinned in apps/package.json: `sbjs-2111`
 * (the last release of the 2.106-2.111 line on the registry), `sbjs-2112` (the
 * first with the opt-in `/tracing` subpath) and `sbjs-latest` (newest on the
 * registry when the pin was made). Row labels carry the installed version read
 * from each package.json at run time.
 *
 * Rows (every id is one client variant: release x packaging):
 *   OB01a  header matrix: for each variant, were traceparent / tracestate /
 *          baggage present at the client's own fetch boundary on (1) a REST
 *          call inside a span, (2) an Edge Function invoke inside a span,
 *          (3) the client's wrapped `fetch` pointed at hosts that are not its
 *          own (plus a client whose own base URL is a non-Supabase host),
 *          (4) a REST call with no active span. Packaging: unbundled (node
 *          resolution), bundled (Bun's bundler, then esbuild) and run next to
 *          node_modules ("tree"), and bundled and run from a directory with
 *          no node_modules ("detached").
 *   OB01b  log side: for each trace id the client generated, which log
 *          sources carry it, and in which field (log_attributes vs message).
 *   OB01c  control variants: the 2.112 release without the `/tracing` import
 *          (docs: one warning, no headers), unsampled spans on the 2.112 and
 *          latest releases (docs: no headers before 2.112.3, traceparent only
 *          from 2.112.3), and tracePropagation left off on the latest release.
 *
 * What the docs say (https://supabase.com/docs/guides/observability/client-side-tracing,
 * https://supabase.com/blog/connect-client-traces-to-your-logs) is kept apart
 * from what this module records. Not settled by this module: browser bundles
 * (only server-side targets were run), webpack/Vite/Turbopack, Realtime
 * websocket frames, Swift/Dart/Python SDKs.
 *
 * DESTRUCTIVE: creates and deletes one project.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { dropProject, evidencePath, logs, makeProject, sleep, sql } from "../lib/ob";

const APPS = resolve(import.meta.dir, "../apps");
const GEN = join(APPS, ".gen");

const ECHO_FN = `
Deno.serve((req) => {
  const seen = {
    traceparent: req.headers.get("traceparent"),
    tracestate: req.headers.get("tracestate"),
    baggage: req.headers.get("baggage"),
  };
  console.log("ob-echo " + JSON.stringify(seen));
  return Response.json(seen, { headers: { "access-control-allow-origin": "*" } });
});
`;

type Sdk = "sbjs-2111" | "sbjs-2112" | "sbjs-latest";
interface Variant {
  id: string;
  sdk: Sdk;
  mode: "unbundled" | "bun-tree" | "bun-detached" | "esbuild-tree" | "esbuild-detached";
  tracingImport: boolean;
  sampled: boolean;
  propagate: boolean;
}

const installed = (sdk: Sdk): string =>
  (JSON.parse(readFileSync(join(APPS, "node_modules", sdk, "package.json"), "utf8")) as { version: string }).version;

function variants(): Variant[] {
  const out: Variant[] = [];
  const sdks: Array<[Sdk, boolean]> = [
    ["sbjs-2111", false],
    ["sbjs-2112", true],
    ["sbjs-latest", true],
  ];
  for (const [sdk, tracing] of sdks) {
    for (const mode of ["unbundled", "bun-tree", "bun-detached", "esbuild-tree", "esbuild-detached"] as const) {
      out.push({ id: `${installed(sdk)}/${mode}`, sdk, mode, tracingImport: tracing, sampled: true, propagate: true });
    }
  }
  // controls (OB01c), unbundled so only the named factor varies
  out.push({ id: `${installed("sbjs-2112")}/no-tracing-import`, sdk: "sbjs-2112", mode: "unbundled", tracingImport: false, sampled: true, propagate: true });
  out.push({ id: `${installed("sbjs-2112")}/unsampled`, sdk: "sbjs-2112", mode: "unbundled", tracingImport: true, sampled: false, propagate: true });
  out.push({ id: `${installed("sbjs-latest")}/unsampled`, sdk: "sbjs-latest", mode: "unbundled", tracingImport: true, sampled: false, propagate: true });
  out.push({ id: `${installed("sbjs-latest")}/tracePropagation-off`, sdk: "sbjs-latest", mode: "unbundled", tracingImport: true, sampled: true, propagate: false });
  return out;
}

interface Seen {
  url: string;
  traceparent: string | null;
  tracestate: string | null;
  baggage: string | null;
}
interface ClientOut {
  traceIds: Record<string, string>;
  rest: { status?: number; error: string | null } | null;
  fn: { error: string | null; data: unknown } | null;
  fnNoSpan?: { traceparent?: string | null; baggage?: string | null } | null;
  seen: Seen[];
  warnings: string[];
}

async function runVariant(v: Variant, env: Record<string, string>): Promise<{ out?: ClientOut; err?: string }> {
  mkdirSync(GEN, { recursive: true });
  const name = v.id.replace(/[^a-z0-9]+/gi, "_");
  const src = readFileSync(join(APPS, "client.template.ts"), "utf8")
    .replaceAll("__SDK__", v.sdk)
    .replaceAll("__TRACING_IMPORT__",v.tracingImport ? `import "${v.sdk}/tracing";` : "");
  const entry = join(GEN, `${name}.ts`);
  writeFileSync(entry, src);
  let runFile = entry;
  let cwd = APPS;
  let tmp = "";
  if (v.mode !== "unbundled") {
    const esb = v.mode.startsWith("esbuild");
    const bundle = join(GEN, `${name}.bundle.${esb ? "mjs" : "js"}`);
    const cmd = esb
      ? [join(APPS, "node_modules/.bin/esbuild"), entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error", "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"]
      : [process.execPath, "build", entry, "--target=bun", "--outfile", bundle];
    const b = Bun.spawnSync(cmd, { cwd: APPS });
    if (b.exitCode !== 0) return { err: `bundle failed: ${b.stderr.toString().slice(0, 300)}` };
    runFile = bundle;
    if (v.mode.endsWith("detached")) {
      tmp = mkdtempSync(join(tmpdir(), "ob01-"));
      const detached = join(tmp, esb ? "app.mjs" : "app.js");
      copyFileSync(bundle, detached);
      runFile = detached;
      cwd = tmp;
    }
  }
  // Bundles run where they would in production: esbuild output under Node (no
  // auto-install), Bun output under `bun --no-install` (a detached Bun run
  // would otherwise fetch missing packages from npm and mask the result).
  const runner = v.mode.startsWith("esbuild") ? ["node", runFile] : v.mode === "unbundled" ? [process.execPath, runFile] : [process.execPath, "--no-install", runFile];
  const p = Bun.spawn(runner, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      OB_RUNTIME: runner[0] === "node" ? "node" : "bun",
      OB_URL: env.OB_URL!,
      OB_KEY: env.OB_KEY!,
      OB_SAMPLED: v.sampled ? "on" : "off",
      OB_PROPAGATE: v.propagate ? "on" : "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  const line = stdout.split("\n").find((l) => l.startsWith("OBJSON "));
  if (!line) return { err: `no output (exit ${p.exitCode}): ${(stderr || stdout).slice(0, 300)}` };
  return { out: JSON.parse(line.slice(7)) as ClientOut };
}

const has = (s: Seen | undefined) => (s?.traceparent ? "traceparent" : "none") + (s?.tracestate ? "+tracestate" : "") + (s?.baggage ? "+baggage" : "");

const mod: TestModule = {
  id: "OB01",
  title: "Client trace propagation: traceparent to trace_id in edge and function logs",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = [
      !Bun.which("node") && "node on PATH",
      !existsSync(join(APPS, "node_modules/.bin/esbuild")) && "apps/node_modules (run `make install`; esbuild missing)",
    ].filter(Boolean);
    if (missing.length) return [{ id: "OB01", title: this.title, status: "skip", detail: `missing: ${missing.join(", ")}` }];
    const results: TestResult[] = [];
    let ref = "";
    try {
      const proj = await makeProject(ctx, "ob01");
      ref = proj.ref;
      const pc = proj.ctx;
      ctx.log(`OB01 project ready (healthy after ${proj.healthyMs} ms)`);
      const ddl = await sql(
        pc,
        "create table if not exists public.ob_probe(id int primary key); insert into public.ob_probe values (1) on conflict do nothing; alter table public.ob_probe enable row level security; drop policy if exists ob_anon_read on public.ob_probe; create policy ob_anon_read on public.ob_probe for select to anon using (true);",
      );
      if (ddl.status >= 300) throw new Error(`ddl: ${ddl.error}`);
      const dep = await deployViaApi(pc, "ob-echo", [{ name: "index.ts", content: ECHO_FN }], { entrypoint_path: "index.ts", name: "ob-echo", verify_jwt: false });
      if (dep.status >= 300) throw new Error(`deploy HTTP ${dep.status} ${dep.error}`);
      // wait until the function answers
      for (let i = 0; i < 20; i++) {
        const r = await fetch(`https://${pc.apiHost}/functions/v1/ob-echo`, { headers: { apikey: pc.anonKey! } }).catch(() => null);
        if (r?.status === 200) break;
        await sleep(3000);
      }

      const env = { OB_URL: `https://${pc.apiHost}`, OB_KEY: pc.anonKey! };
      const outs = new Map<string, ClientOut>();
      const t0 = Date.now();
      for (const v of variants()) {
        const r = await runVariant(v, env);
        if (r.out) outs.set(v.id, r.out);
        const seen = r.out?.seen ?? [];
        // order fixed by the client: rest, fn, own-host client, then four wrapped-fetch URLs, then no-span control
        const [rest, fn, own, third, lookalike1, lookalike2, otherRef, ctl] = seen;
        const matrix: Record<string, number | string> = {
          rest_headers: has(rest),
          fn_headers: has(fn),
          client_on_third_party_url: has(own),
          wrapped_fetch_third_party: has(third),
          wrapped_fetch_xsupabase_co: has(lookalike1),
          wrapped_fetch_supabase_co_suffix_host: has(lookalike2),
          wrapped_fetch_other_supabase_co_project: has(otherRef),
          no_span_headers: has(ctl),
          fn_no_span_received: r.out?.fnNoSpan?.traceparent
            ? `traceparent flags=${r.out.fnNoSpan.traceparent.split("-")[3]} baggage=${(r.out.fnNoSpan.baggage ?? "none").split("=")[0]}`
            : "none",
          fn_received_client_trace_id: ((r.out?.fn?.data as { traceparent?: string | null } | null)?.traceparent ?? "").includes(r.out?.traceIds.fn ?? "no-id") ? "yes" : "no",
          rest_status: r.out?.rest?.status ?? -1,
          fn_error: r.out?.fn?.error ?? "none",
          warnings: (r.out?.warnings ?? []).join(" | ").slice(0, 160) || "none",
        };
        results.push({
          id: `OB01a ${v.id}`,
          title: `OB01a: ${v.id}`,
          status: r.out ? "info" : "fail",
          detail: r.err ?? `rest=${has(rest)} fn=${has(fn)} own-third-party-url=${has(own)} wrapped-third-party=${has(third)}`,
          measurements: matrix,
        });
      }

      writeFileSync(evidencePath("ob01-clients.json"), JSON.stringify([...outs.entries()], null, 1));

      // ---- log side
      const list = [...outs.values()].flatMap((o) => Object.values(o.traceIds));
      const inList = list.map((t) => `'${t}'`).join(",");
      const found = new Map<string, Set<string>>();
      const deadline = Date.now() + 6 * 60_000;
      let lastErr = "";
      let firstSeenMs = -1;
      while (Date.now() < deadline) {
        await sleep(30_000);
        // (1) the trace_id attribute, any source; (2) the lines the echo function printed (its own console output).
        const q1 = await logs(pc, `select source, log_attributes['trace_id'] as tid, count(*) as n from logs where log_attributes['trace_id'] in (${inList}) group by source, tid`, 1);
        const q2 = await logs(pc, "select source, event_message from logs where source = 'function_logs' and position(event_message, 'ob-echo') > 0 limit 500", 1);
        lastErr = q1.error || q2.error;
        for (const r of q1.rows as Array<{ source: string; tid: string }>) {
          if (!found.has(r.tid)) found.set(r.tid, new Set());
          found.get(r.tid)!.add(`${r.source}:trace_id`);
        }
        for (const r of q2.rows as Array<{ source: string; event_message: string }>) {
          for (const t of list) {
            if (r.event_message.includes(t)) {
              if (!found.has(t)) found.set(t, new Set());
              found.get(t)!.add(`${r.source}:event_message`);
            }
          }
        }
        if (firstSeenMs < 0 && found.size) firstSeenMs = Date.now() - t0;
        // done when every trace id seen at a fetch boundary with a traceparent has an edge hit
        const expected = [...outs.values()].flatMap((o) => (o.seen[0]?.traceparent ? [o.traceIds.rest!] : []));
        if (expected.every((t) => [...(found.get(t) ?? [])].some((s) => s.startsWith("edge_logs:")))) break;
      }
      for (const [vid, o] of outs) {
        const m: Record<string, number | string> = {};
        for (const call of ["rest", "fn", "third"] as const) {
          const t = o.traceIds[call]!;
          m[`${call}_sources`] = [...(found.get(t) ?? [])].sort().join(",") || "none";
        }
        results.push({
          id: `OB01b ${vid}`,
          title: `OB01b: ${vid} trace ids in logs`,
          status: "info",
          measurements: m,
          detail: lastErr ? `last logs error: ${lastErr}` : undefined,
        });
      }
      // Field discovery on a sample (the three unbundled variants, REST and function ids): any source, any
      // attribute key or the message holding the id. A sample keeps the query small enough for the endpoint.
      const sample = [...outs.entries()].filter(([vid]) => vid.endsWith("/unbundled")).flatMap(([, o]) => [o.traceIds.rest!, o.traceIds.fn!]);
      const sl = sample.map((t) => `'${t}'`).join(",");
      const qd = await logs(
        pc,
        `select source, arrayFilter(k -> multiSearchAny(log_attributes[k], [${sl}]), mapKeys(log_attributes)) as keys, multiSearchAny(event_message, [${sl}]) as in_message, count(*) as n from logs ` +
          `where multiSearchAny(event_message, [${sl}]) or arrayExists(v -> multiSearchAny(v, [${sl}]), mapValues(log_attributes)) group by source, keys, in_message`,
        1,
      );
      results.push({
        id: "OB01e",
        title: "OB01e: every source and attribute key holding a client trace id (sample: three unbundled variants, REST and function ids)",
        status: qd.error ? "fail" : "info",
        detail: qd.error || undefined,
        measurements: Object.fromEntries((qd.rows as Array<{ source: string; keys: string[]; in_message: number; n: number }>).map((r, i) => [`${i}_${r.source}`, `keys=[${r.keys.join(",")}] in_message=${r.in_message} rows=${r.n}`])),
      });
      // Which sources stamp a trace_id attribute at all (any value), over the whole project window.
      const q3 = await logs(pc, "select source, count(*) as n, countIf(log_attributes['trace_id'] != '') as with_trace_id from logs group by source", 1);
      results.push({
        id: "OB01d",
        title: "OB01d: log sources that carry a trace_id attribute",
        status: q3.error ? "fail" : "info",
        detail: q3.error || undefined,
        measurements: Object.fromEntries((q3.rows as Array<{ source: string; n: number; with_trace_id: number }>).map((r) => [r.source, `${r.with_trace_id} of ${r.n}`])),
      });
      results.push({ id: "OB01", title: "OB01 complete", status: "info", detail: `${outs.size} variants, ${list.length} trace ids, first log hit ${firstSeenMs} ms after first client run` });
    } catch (e) {
      results.push({ id: "OB01", title: "OB01", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await dropProject(ctx, ref);
    }
    return results;
  },
};
export default mod;
