/**
 * MF06 - connection-level faults that stop a request before upstream sees it.
 *
 * MF01-MF05 injected HTTP statuses and delays. Here the failure is the
 * connection itself, for a read (`GET /v1/projects`) and for a project create
 * (`POST /v1/projects`), from three clients: the supabase CLI, Bun `fetch()`
 * and Node `fetch()` (lib/clients.ts).
 *
 *   MF06a  reset-before: the in-process proxy (lib/connfault.ts) reads the
 *          whole request and aborts the TCP connection with an RST
 *   MF06b  close-before: same, closed with a FIN (no answer, no reset)
 *   MF06c  connection refused: a loopback port with nothing listening
 *   MF06d  TLS failure: a listener with a self-signed certificate
 *   MF06e  DNS failure: a host under the reserved `.invalid` TLD
 *   MF06f  reset-before on a POST that rides a kept-alive connection (a GET
 *          answered first on the same client): does either fetch resend it
 *
 * Attempts are counted at the wire where a listener exists: proxy log rows
 * (a, b, f) and TCP connections accepted by the TLS listener (d). For refused
 * and DNS there is nothing to count at; the cell records the time and the
 * message only. The CLI's `--debug` log prints one "HTTP GET:" line per
 * logical call, not per attempt (6 attempts at the proxy, 1 debug line, in the
 * development run), so it is not used as a count.
 *
 * No upstream contact is possible in any of these cells, so no project should
 * appear; MF06g lists the org afterwards for names carrying this run's tag
 * and any found are swept in `finally`.
 */
import { existsSync, rmSync } from "node:fs";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { bunCall, cliCall, nodeCall, type CallResult, type ClientKind } from "../lib/clients.js";
import { connShape, DNS_FAIL_HOST, refusedUrl, startConnProxy, startTlsTrap, type ConnLogRow } from "../lib/connfault.js";
import { dbPassword, listPrefixed, missingTool, NAME_PREFIX, scratchDir, scrub, sweep, waitGone } from "../lib/proxy.js";

const PATH = /^\/v1\/projects$/;
const CLIENTS: ClientKind[] = ["cli", "bun", "node"];

type Fault = "reset-before" | "close-before" | "refused" | "tls" | "dns";

const mod: TestModule = {
  id: "MF06",
  title: "Connection reset, close, refused, TLS and DNS failures before upstream: CLI, Bun fetch, Node fetch",
  where: "local",
  requires: ["pat"],
  // The POST cells send a real create body to a proxy that must not forward
  // it; a proxy bug would create a project, so this sits in the destructive tier.
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF06", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = await missingTool(["supabase"]);
    if (missing) return [{ id: "MF06", title: this.title, status: "skip", detail: missing }];
    if (!Bun.which("node")) return [{ id: "MF06", title: this.title, status: "skip", detail: "node not found on PATH" }];
    const pat = ctx.pat ?? "";
    const tag = `${NAME_PREFIX}c6-${Date.now().toString(36)}`;
    const mine = (n: string) => n.startsWith(tag);
    const dir = scratchDir("conn");
    const results: TestResult[] = [];
    let seq = 0;
    const createBody = () => ({ organization_slug: org, name: `${tag}-${++seq}`, db_pass: dbPassword(), region: "ap-southeast-1" });

    const call = (client: ClientKind, base: string, method: "GET" | "POST", pre = false): Promise<CallResult> => {
      if (client === "cli") {
        const args = method === "GET"
          ? ["projects", "list", "-o", "json"]
          : ["projects", "create", `${tag}-${++seq}`, "--org-id", org, "--db-password", dbPassword(), "--region", "ap-southeast-1", "--yes"]; // argv-secret-ok: throwaway project password, the project is never created
        return cliCall(base, args, pat, dir, 400_000);
      }
      const body = method === "POST" ? createBody() : undefined;
      return client === "bun" ? bunCall(base, method, "/v1/projects", pat, body, pre) : nodeCall(base, method, "/v1/projects", pat, body, pre);
    };

    const span = (rows: ConnLogRow[]) => (rows.length > 1 ? rows[rows.length - 1]!.t - rows[0]!.t : 0);

    try {
      // ---- MF06a/b: reset and close before upstream, at the proxy ----
      for (const [id, mode] of [["MF06a", "reset-before"], ["MF06b", "close-before"]] as const) {
        const m: Record<string, number | string> = {};
        const lines: string[] = [];
        const ev: string[] = [];
        for (const method of ["GET", "POST"] as const) {
          for (const client of CLIENTS) {
            const px = startConnProxy();
            try {
              px.setRules([{ id: mode, method, path: "^/v1/projects$", mode }]);
              const r = await call(client, px.url, method);
              const lg = px.log();
              const hits = lg.filter((x) => x.method === method && PATH.test(x.path));
              const k = `${client}_${method}`;
              m[`${k}_attempts`] = hits.length;
              m[`${k}_conns`] = px.conns();
              m[`${k}_first_to_last_ms`] = span(hits);
              m[`${k}_ms`] = r.ms;
              m[`${k}_outcome`] = r.exit !== undefined ? `exit ${r.exit}` : r.status !== undefined ? `status ${r.status}` : "threw";
              m[`${k}_upstream_forwards`] = lg.filter((x) => x.upstreamStatus !== undefined).length;
              lines.push(`${client} ${method}: ${hits.length} attempt(s) over ${px.conns()} connection(s), ${m[`${k}_outcome`]}, ${r.ms} ms`);
              ev.push(`[${client} ${method}] ${r.error ?? `status ${r.status}`}\n${connShape(lg)}${client === "cli" ? `\n${r.text.split("\n").slice(0, 8).join("\n")}` : ""}`);
            } finally {
              px.stop();
            }
          }
        }
        results.push({ id, title: `${id}: ${mode} (proxy reads the request, upstream not contacted)`, status: "info", detail: lines.join("; "), measurements: m, evidence: scrub(ev.join("\n\n")) });
      }

      // ---- MF06c/d/e: refused, TLS, DNS ----
      const targets: Array<[string, Fault]> = [["MF06c", "refused"], ["MF06d", "tls"], ["MF06e", "dns"]];
      for (const [id, fault] of targets) {
        const m: Record<string, number | string> = {};
        const lines: string[] = [];
        const ev: string[] = [];
        for (const method of ["GET", "POST"] as const) {
          for (const client of CLIENTS) {
            const trap = fault === "tls" ? startTlsTrap() : undefined;
            const base = fault === "refused" ? refusedUrl() : fault === "dns" ? `https://${DNS_FAIL_HOST}` : trap!.url.replace("localhost", "127.0.0.1");
            try {
              const r = await call(client, base, method);
              const k = `${client}_${method}`;
              m[`${k}_ms`] = r.ms;
              m[`${k}_outcome`] = r.exit !== undefined ? `exit ${r.exit}` : r.status !== undefined ? `status ${r.status}` : "threw";
              let extra = "";
              if (trap) {
                const c = trap.counts();
                m[`${k}_tls_conns`] = c.conns;
                m[`${k}_tls_handshake_ok`] = c.handshakeOk;
                m[`${k}_tls_request_bytes_events`] = c.dataEvents;
                extra = `, ${c.conns} TCP connection(s), ${c.handshakeOk} handshake(s) completed`;
              }
              lines.push(`${client} ${method}: ${m[`${k}_outcome`]}, ${r.ms} ms${extra}`);
              ev.push(`[${client} ${method}] ${r.error ?? `status ${r.status}`}${client === "cli" ? `\n${r.text.split("\n").slice(0, 8).join("\n")}` : ""}`);
            } finally {
              trap?.stop();
            }
          }
        }
        results.push({ id, title: `${id}: ${fault === "refused" ? "connection refused" : fault === "tls" ? "TLS failure (self-signed certificate)" : "DNS failure (.invalid host)"}`, status: "info", detail: lines.join("; "), measurements: m, evidence: scrub(ev.join("\n\n").replaceAll(DNS_FAIL_HOST, "{dns-fail-host}")) });
      }

      // ---- MF06f: reset-before on a POST over a kept-alive connection ----
      {
        const m: Record<string, number | string> = {};
        const lines: string[] = [];
        const ev: string[] = [];
        for (const client of ["bun", "node"] as const) {
          const px = startConnProxy();
          try {
            px.setRules([{ id: "rb-post", method: "POST", path: "^/v1/projects$", mode: "reset-before" }]);
            const r = await call(client, px.url, "POST", true);
            const lg = px.log();
            const posts = lg.filter((x) => x.method === "POST");
            const getConn = lg.find((x) => x.method === "GET")?.conn;
            m[`${client}_post_attempts`] = posts.length;
            m[`${client}_conns`] = px.conns();
            m[`${client}_first_post_on_get_conn`] = posts[0]?.conn === getConn ? "yes" : "no";
            m[`${client}_ms`] = r.ms;
            lines.push(`${client}: ${posts.length} POST attempt(s), ${px.conns()} connection(s), first POST on the GET's connection: ${m[`${client}_first_post_on_get_conn`]}`);
            ev.push(`[${client}] ${r.error ?? `status ${r.status}`}\n${connShape(lg)}\nconn ids: ${lg.map((x) => `${x.method}@${x.conn}`).join(" ")}`);
          } finally {
            px.stop();
          }
        }
        results.push({ id: "MF06f", title: "MF06f: fetch POST reset on a kept-alive connection (GET answered first)", status: "info", detail: lines.join("; "), measurements: m, evidence: scrub(ev.join("\n\n")) });
      }

      // ---- MF06g: nothing was created ----
      await Bun.sleep(15_000);
      const found = (await listPrefixed(ctx)).filter((p) => mine(p.name));
      results.push({
        id: "MF06g",
        title: "MF06g: projects carrying this run's tag after every MF06 cell",
        status: found.length === 0 ? "pass" : "fail",
        detail: `${found.length} project(s) with the run's name tag (${seq} create names were used)`,
        measurements: { projects_with_tag: found.length, create_names_used: seq },
      });
    } catch (e) {
      results.push({ id: "MF06", title: "MF06", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const left = (await listPrefixed(ctx).catch(() => [])).filter((p) => mine(p.name));
      if (left.length) {
        await sweep(ctx, mine).catch(() => 0);
        await waitGone(ctx, mine, 180_000).catch(() => false);
      }
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return results;
  },
};
export default mod;
