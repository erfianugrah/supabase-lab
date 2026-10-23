/**
 * MF07 - a create whose connection is reset AFTER upstream created the
 * project, two retry policies, and the reconciler that finds the orphans.
 *
 * The in-process proxy (lib/connfault.ts, mode reset-after) forwards the
 * POST, waits for upstream's answer, then aborts the client's TCP connection
 * with an RST, once. Each client keeps a local ledger (JSON Lines) of the
 * creates it heard a 2xx for; that ledger is the "local record" the
 * reconciler compares the org listing against.
 *
 *   MF07a  supabase CLI `projects create`: exit, message, POST attempts,
 *          projects with the name afterwards
 *   MF07b  Bun `fetch()` POST: the same
 *   MF07c  a client that retries a failed create with a FRESH name each time
 *          (timestamp suffix, the lab's own naming habit): projects afterwards
 *   MF07d  a client that, on a transport error, lists the org for the name it
 *          sent before retrying, and adopts the project if it is there
 *   MF07e  lib/reconcile.ts against the ledger: which projects it flags, with
 *          no grace window and with the default 300 s one; run in-process and
 *          as the command-line script (exit code 3 = orphans). Also counts
 *          how many tagged projects have a `created_at` at or after the
 *          module start: the 2026-10-23 run used a reconciler that filtered
 *          on exactly that, and it dropped all five (see RUNLOG)
 *   MF07f  after the sweep: the reconciler again, and the listing
 *
 * Creates five projects at most (a, b, c x2, d); a guard stops the module
 * before any create beyond that. Every project with this run's name tag is
 * deleted in `finally`. MF_REFS_FILE, when set, receives one line per project
 * ref this module saw (outside the repo; refs never go into evidence).
 */
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { bunCall, cliCall, type CallResult } from "../lib/clients.js";
import { connShape, startConnProxy, type ConnProxy } from "../lib/connfault.js";
import { dbPassword, listPrefixed, missingTool, NAME_PREFIX, runCmd, scratchDir, scrub, sweep, waitGone } from "../lib/proxy.js";
import { listProjects, readLedger, reconcile } from "../lib/reconcile.js";

const MAX_CREATES = 5;
/** The ref from a create answer, or undefined; the ledger still matches by name. */
const refOf = (text: string): string | undefined => {
  try {
    return (JSON.parse(text) as { ref?: string }).ref;
  } catch {
    return undefined;
  }
};
const RECONCILE = resolve(import.meta.dir, "../lib/reconcile.ts");

const mod: TestModule = {
  id: "MF07",
  title: "Create reset after upstream created it: CLI, fetch, two retry policies, and the orphan reconciler",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF07", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const missing = await missingTool(["supabase"]);
    if (missing) return [{ id: "MF07", title: this.title, status: "skip", detail: missing }];
    const pat = ctx.pat ?? "";
    const tag = `${NAME_PREFIX}c7-${Date.now().toString(36)}`;
    const mine = (n: string) => n.startsWith(tag);
    const dir = scratchDir("orphans");
    const ledger = join(dir, "ledger.jsonl");
    const refsFile = process.env.MF_REFS_FILE;
    const start = new Date(Date.now() - 5_000);
    const results: TestResult[] = [];
    let creates = 0; // upstream 2xx answers to POST /v1/projects, across every proxy
    const proxies: ConnProxy[] = [];

    const record = (name: string, ref?: string) => appendFileSync(ledger, `${JSON.stringify({ name, ref })}\n`);
    const noteRefs = async () => {
      if (!refsFile) return;
      for (const p of (await listPrefixed(ctx)).filter((x) => mine(x.name))) appendFileSync(refsFile, `${new Date().toISOString()} MF07 ${p.ref} ${p.name}\n`);
    };
    const named = async (name: string, waitMs = 30_000) => {
      const t0 = Date.now();
      let rows = (await listPrefixed(ctx)).filter((p) => p.name === name);
      while (rows.length === 0 && Date.now() - t0 < waitMs) {
        await Bun.sleep(4000);
        rows = (await listPrefixed(ctx)).filter((p) => p.name === name);
      }
      return rows;
    };
    const proxy = () => {
      const px = startConnProxy();
      proxies.push(px);
      return px;
    };
    const countCreates = (px: ConnProxy) =>
      px.log().filter((r) => r.method === "POST" && /^\/v1\/projects$/.test(r.path) && (r.upstreamStatus ?? 0) >= 200 && (r.upstreamStatus ?? 0) < 300).length;
    const guard = (next: number) => {
      if (creates + next > MAX_CREATES) throw new Error(`create budget: ${creates} done, ${next} more would pass ${MAX_CREATES}`);
    };
    const body = (name: string) => ({ organization_slug: org, name, db_pass: dbPassword(), region: "ap-southeast-1" });
    const outcome = (r: CallResult) => (r.exit !== undefined ? `exit ${r.exit}` : r.status !== undefined ? `status ${r.status}` : "threw");

    try {
      // ---- MF07a: CLI ----
      {
        guard(1);
        const px = proxy();
        const name = `${tag}-a`;
        px.setRules([{ id: "ra", method: "POST", path: "^/v1/projects$", mode: "reset-after", times: 1 }]);
        const r = await cliCall(px.url, ["projects", "create", name, "--org-id", org, "--db-password", dbPassword(), "--region", "ap-southeast-1", "--yes"], pat, dir); // argv-secret-ok: throwaway project password, deleted in finally
        if (r.exit === 0) record(name);
        const lg = px.log();
        creates += countCreates(px);
        const found = await named(name);
        const posts = lg.filter((x) => x.method === "POST");
        results.push({
          id: "MF07a",
          title: "MF07a: CLI create, connection reset after upstream created the project",
          status: "info",
          detail: `CLI ${outcome(r)} after ${r.ms} ms; ${posts.length} POST attempt(s) (upstream ${posts.map((x) => x.upstreamStatus ?? "-").join(",")}); projects with the name: ${found.length}`,
          measurements: { exit: r.exit ?? -1, ms: r.ms, post_attempts: posts.length, first_upstream_status: posts[0]?.upstreamStatus ?? -1, projects_with_name: found.length, ledger_entry: r.exit === 0 ? 1 : 0 },
          evidence: scrub(`${r.error ?? ""}\n${connShape(lg)}\n${r.text.split("\n").slice(0, 10).join("\n")}`),
        });
      }

      // ---- MF07b: Bun fetch ----
      {
        guard(1);
        const px = proxy();
        const name = `${tag}-b`;
        px.setRules([{ id: "ra", method: "POST", path: "^/v1/projects$", mode: "reset-after", times: 1 }]);
        const r = await bunCall(px.url, "POST", "/v1/projects", pat, body(name));
        if (r.status && r.status < 300) record(name);
        const lg = px.log();
        creates += countCreates(px);
        const found = await named(name);
        const posts = lg.filter((x) => x.method === "POST");
        results.push({
          id: "MF07b",
          title: "MF07b: Bun fetch create, connection reset after upstream created the project",
          status: "info",
          detail: `fetch ${outcome(r)} after ${r.ms} ms (${r.error ?? ""}); ${posts.length} POST attempt(s) (upstream ${posts.map((x) => x.upstreamStatus ?? "-").join(",")}); projects with the name: ${found.length}`,
          measurements: { ms: r.ms, outcome: outcome(r), post_attempts: posts.length, first_upstream_status: posts[0]?.upstreamStatus ?? -1, projects_with_name: found.length },
          evidence: scrub(`${r.error ?? ""}\n${connShape(lg)}`),
        });
      }

      // ---- MF07c: retry with a fresh name each time ----
      {
        guard(2);
        const px = proxy();
        px.setRules([{ id: "ra", method: "POST", path: "^/v1/projects$", mode: "reset-after", times: 1 }]);
        const tried: string[] = [];
        let final: CallResult | undefined;
        for (let i = 1; i <= 2; i++) {
          const name = `${tag}-c${i}-${Date.now().toString(36)}`;
          tried.push(name);
          final = await bunCall(px.url, "POST", "/v1/projects", pat, body(name));
          if (final.status && final.status < 300) {
            const ref = refOf(final.text);
            record(name, ref);
            break;
          }
          if (final.status !== undefined) break; // an HTTP error is not retried
          await Bun.sleep(2000);
        }
        creates += countCreates(px);
        const lg = px.log();
        await Bun.sleep(5000);
        const found = (await listPrefixed(ctx)).filter((p) => tried.includes(p.name));
        results.push({
          id: "MF07c",
          title: "MF07c: retry with a fresh name after a reset-after create",
          status: "info",
          detail: `${tried.length} create attempt(s), last ${final ? outcome(final) : "-"}; projects from those names: ${found.length}; ledger holds 1 of them`,
          measurements: { attempts: tried.length, projects_created: found.length, last_status: final?.status ?? -1 },
          evidence: scrub(connShape(lg)),
        });
      }

      // ---- MF07d: check the listing before retrying, same name ----
      {
        guard(1);
        const px = proxy();
        px.setRules([{ id: "ra", method: "POST", path: "^/v1/projects$", mode: "reset-after", times: 1 }]);
        const name = `${tag}-d`;
        const steps: string[] = [];
        let adopted = false;
        for (let i = 1; i <= 2 && !adopted; i++) {
          const r = await bunCall(px.url, "POST", "/v1/projects", pat, body(name));
          steps.push(`POST ${outcome(r)}${r.error ? ` (${r.error.split(":")[0]})` : ""}`);
          if (r.status && r.status < 300) {
            record(name, refOf(r.text));
            adopted = true;
            break;
          }
          // transport error or 400 (name taken): look for the name before trying again
          const t0 = Date.now();
          while (Date.now() - t0 < 30_000) {
            // the client lists through the same base it creates through (the proxy passes GETs)
            const p = (await listProjects(pat, `${px.url}/v1`).catch(() => [])).find((x) => x.name === name);
            if (p) {
              record(name, p.ref);
              adopted = true;
              steps.push(`found by listing after ${Date.now() - t0} ms, adopted`);
              break;
            }
            await Bun.sleep(3000);
          }
        }
        creates += countCreates(px);
        const lg = px.log();
        const found = await named(name);
        results.push({
          id: "MF07d",
          title: "MF07d: on a transport error, list for the name before retrying",
          status: "info",
          detail: `${steps.join("; ")}; POSTs sent ${lg.filter((x) => x.method === "POST").length}; projects with the name: ${found.length}; in ledger: ${adopted ? "yes" : "no"}`,
          measurements: { posts: lg.filter((x) => x.method === "POST").length, projects_with_name: found.length, adopted: adopted ? 1 : 0 },
          evidence: scrub(connShape(lg)),
        });
      }
      await noteRefs();

      // ---- MF07e: the reconciler ----
      {
        await Bun.sleep(5000);
        const listed = await listProjects(pat);
        const led = readLedger(ledger);
        const r0 = reconcile(listed, led, { prefix: tag, graceMs: 0, org });
        const r300 = reconcile(listed, led, { prefix: tag, graceMs: 300_000, org });
        // The filter the first version of the reconciler used (created_at at or after the module start).
        const createdAfterStart = listed.filter((p) => mine(p.name) && Date.parse(p.created_at) >= start.getTime()).length;
        const ages = listed.filter((p) => mine(p.name)).map((p) => Math.round((Date.now() - Date.parse(p.created_at)) / 1000));
        const cmd = await runCmd(["bun", RECONCILE, "--ledger", ledger, "--prefix", tag, "--grace-s", "0", "--org", org], {
          env: { SUPABASE_ACCESS_TOKEN: pat },
          timeoutMs: 60_000,
        });
        let cliOrphans = -1;
        try {
          cliOrphans = (JSON.parse(cmd.stdout) as { orphan: unknown[] }).orphan.length;
        } catch {
          /* recorded as -1 */
        }
        const short = (n: string) => n.slice(tag.length + 1).replace(/-[a-z0-9]+$/, "");
        results.push({
          id: "MF07e",
          title: "MF07e: reconciler against the ledger after MF07a-d",
          status: "info",
          detail: `grace 0: orphan [${r0.orphan.map((p) => short(p.name)).sort().join(",")}], tracked [${r0.tracked.map((p) => short(p.name)).sort().join(",")}]; grace 300 s: orphan ${r300.orphan.length}, young ${r300.young.length}; script exit ${cmd.code} with ${cliOrphans} orphan(s); project ages ${Math.min(...ages)}-${Math.max(...ages)} s`,
          measurements: {
            ledger_entries: led.length,
            created_at_after_start: createdAfterStart,
            listed_with_tag: listed.filter((p) => mine(p.name)).length,
            grace0_orphan: r0.orphan.length,
            grace0_tracked: r0.tracked.length,
            grace0_young: r0.young.length,
            grace300_orphan: r300.orphan.length,
            grace300_young: r300.young.length,
            script_exit: cmd.code ?? -1,
            script_orphans: cliOrphans,
            min_age_s: Math.min(...ages),
            max_age_s: Math.max(...ages),
          },
          evidence: `orphan names (tag stripped): ${r0.orphan.map((p) => short(p.name)).sort().join(", ")}\ntracked: ${r0.tracked.map((p) => short(p.name)).sort().join(", ")}\nyoung at 300 s grace: ${r300.young.map((p) => short(p.name)).sort().join(", ")}`,
        });
      }

      // ---- MF07f: after the sweep ----
      {
        const deleted = await sweep(ctx, mine);
        const gone = await waitGone(ctx, mine, 240_000);
        const r = reconcile(await listProjects(pat), readLedger(ledger), { prefix: tag, graceMs: 0, org });
        results.push({
          id: "MF07f",
          title: "MF07f: reconciler after deleting every tagged project",
          status: gone && r.orphan.length === 0 ? "pass" : "fail",
          detail: `DELETEs accepted ${deleted}; listing empty for the tag: ${gone}; orphan ${r.orphan.length}, tracked ${r.tracked.length}, ledger entries with no project ${r.absent.length}`,
          measurements: { deletes_accepted: deleted, gone: gone ? 1 : 0, orphan: r.orphan.length, tracked: r.tracked.length, absent: r.absent.length, upstream_creates: creates },
        });
      }
    } catch (e) {
      results.push({ id: "MF07", title: "MF07", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      for (const px of proxies) px.stop();
      await noteRefs().catch(() => undefined);
      const left = (await listPrefixed(ctx).catch(() => [])).filter((p) => mine(p.name));
      if (left.length) {
        await sweep(ctx, mine).catch(() => 0);
        await waitGone(ctx, mine, 240_000).catch(() => false);
      }
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return results;
  },
};
export default mod;
