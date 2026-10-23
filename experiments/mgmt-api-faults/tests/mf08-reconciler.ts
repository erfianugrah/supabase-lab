/**
 * MF08 - the reconciler finds an induced orphan, and `created_at` against the
 * time the create was sent.
 *
 * MF07e (2026-10-23) ran a first version of lib/reconcile.ts that kept only
 * projects whose `created_at` was at or after the module start; it reported
 * nothing, and the five fresh projects showed `created_at` ages of 486-564 s
 * about 20 s after they were created. The reconciler now ignores
 * `created_at` and keeps first-seen times in a state file. This module
 * creates ONE project to check both:
 *
 *   MF08a  Bun `fetch()` create through the in-process proxy, reset after
 *          upstream answered (an orphan, no ledger line). Records the local
 *          time the POST reached the proxy, the `created_at` in upstream's
 *          answer (captured by the proxy before the reset) and in the
 *          listing.
 *   MF08b  the command-line reconciler with a fresh state file and a 30 s
 *          grace window: first pass (expected: young, exit 0), a second pass
 *          35 s later (expected: orphan, exit 3, the induced name), and how
 *          many tagged projects the old `created_at >= start` filter keeps.
 *   MF08c  after deleting the project: the reconciler again (exit 0).
 *
 * The project is deleted in `finally` whatever happens.
 */
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { bunCall } from "../lib/clients.js";
import { connShape, startConnProxy } from "../lib/connfault.js";
import { dbPassword, listPrefixed, NAME_PREFIX, runCmd, scratchDir, sweep, waitGone } from "../lib/proxy.js";

const RECONCILE = resolve(import.meta.dir, "../lib/reconcile.ts");

const mod: TestModule = {
  id: "MF08",
  title: "Reconciler on one induced orphan (first-seen grace), and created_at against the send time",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.pro ?? "";
    if (!org) return [{ id: "MF08", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const pat = ctx.pat ?? "";
    const tag = `${NAME_PREFIX}c8-${Date.now().toString(36)}`;
    const mine = (n: string) => n.startsWith(tag);
    const name = `${tag}-a`;
    const dir = scratchDir("reconcile");
    const ledger = join(dir, "ledger.jsonl");
    const state = join(dir, "state.json");
    writeFileSync(ledger, "");
    const start = Date.now();
    const results: TestResult[] = [];
    const px = startConnProxy();
    const recon = async () => {
      const r = await runCmd(["bun", RECONCILE, "--ledger", ledger, "--prefix", tag, "--state", state, "--grace-s", "30", "--org", org], {
        env: { SUPABASE_ACCESS_TOKEN: pat },
        timeoutMs: 60_000,
      });
      let j: { orphan: Array<{ name: string }>; young: Array<{ name: string }>; tracked: unknown[] } = { orphan: [], young: [], tracked: [] };
      try {
        j = JSON.parse(r.stdout);
      } catch {
        /* exit code and counts of -1 tell the story */
      }
      return { exit: r.code ?? -1, orphan: j.orphan.map((p) => p.name), young: j.young.map((p) => p.name), tracked: j.tracked.length };
    };
    try {
      // ---- MF08a ----
      px.setRules([{ id: "ra", method: "POST", path: "^/v1/projects$", mode: "reset-after", times: 1 }]);
      const r = await bunCall(px.url, "POST", "/v1/projects", pat, { organization_slug: org, name, db_pass: dbPassword(), region: "ap-southeast-1" });
      const row = px.log().find((x) => x.method === "POST");
      let listed = (await listPrefixed(ctx)).filter((p) => p.name === name);
      for (let i = 0; i < 8 && listed.length === 0; i++) {
        await Bun.sleep(4000);
        listed = (await listPrefixed(ctx)).filter((p) => p.name === name);
      }
      if (process.env.MF_REFS_FILE) for (const p of listed) appendFileSync(process.env.MF_REFS_FILE, `${new Date().toISOString()} MF08 ${p.ref} ${p.name}\n`);
      const full = listed.length
        ? ((await (await fetch("https://api.supabase.com/v1/projects", { headers: { Authorization: `Bearer ${pat}` } })).json()) as Array<{ name: string; created_at: string }>).find((p) => p.name === name)
        : undefined;
      const sent = row?.t ?? 0;
      const answerOffset = row?.upstreamCreatedAt ? Math.round((sent - Date.parse(row.upstreamCreatedAt)) / 1000) : -1;
      const listOffset = full ? Math.round((sent - Date.parse(full.created_at)) / 1000) : -1;
      results.push({
        id: "MF08a",
        title: "MF08a: create reset after upstream answered; created_at against the send time",
        status: listed.length === 1 ? "info" : "fail",
        detail: `fetch ${r.error ? `threw (${r.error.split(":")[0]})` : `status ${r.status}`}; upstream ${row?.upstreamStatus ?? "-"}; projects with the name: ${listed.length}; send time minus created_at: answer ${answerOffset} s, listing ${listOffset} s`,
        measurements: {
          upstream_status: row?.upstreamStatus ?? -1,
          projects_with_name: listed.length,
          send_minus_created_at_answer_s: answerOffset,
          send_minus_created_at_listing_s: listOffset,
          answer_and_listing_created_at_equal: row?.upstreamCreatedAt && full ? (row.upstreamCreatedAt === full.created_at ? "yes" : "no") : "-",
        },
        evidence: connShape(px.log()),
      });

      // ---- MF08b ----
      const createdAfterStart = full && Date.parse(full.created_at) >= start ? 1 : 0;
      const p1 = await recon();
      await Bun.sleep(35_000);
      const p2 = await recon();
      const ok = p1.exit === 0 && p1.young.includes(name) && p2.exit === 3 && p2.orphan.length === 1 && p2.orphan[0] === name;
      results.push({
        id: "MF08b",
        title: "MF08b: reconciler script, 30 s grace from first sighting, two passes 35 s apart",
        status: ok ? "pass" : "fail",
        detail: `pass 1: exit ${p1.exit}, young ${p1.young.length}, orphan ${p1.orphan.length}; pass 2: exit ${p2.exit}, orphan ${p2.orphan.length} (the induced name: ${p2.orphan[0] === name ? "yes" : "no"}); old created_at >= start filter keeps ${createdAfterStart} of 1`,
        measurements: {
          pass1_exit: p1.exit,
          pass1_young: p1.young.length,
          pass1_orphan: p1.orphan.length,
          pass2_exit: p2.exit,
          pass2_orphan: p2.orphan.length,
          pass2_is_induced: p2.orphan[0] === name ? 1 : 0,
          old_filter_kept: createdAfterStart,
        },
      });

      // ---- MF08c ----
      const deleted = await sweep(ctx, mine);
      const gone = await waitGone(ctx, mine, 240_000);
      const p3 = await recon();
      results.push({
        id: "MF08c",
        title: "MF08c: reconciler after the delete",
        status: gone && p3.exit === 0 && p3.orphan.length === 0 ? "pass" : "fail",
        detail: `DELETEs accepted ${deleted}; listing empty for the tag: ${gone}; reconciler exit ${p3.exit}, orphan ${p3.orphan.length}`,
        measurements: { deletes_accepted: deleted, gone: gone ? 1 : 0, exit: p3.exit, orphan: p3.orphan.length },
      });
    } catch (e) {
      results.push({ id: "MF08", title: "MF08", status: "fail", detail: `test threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      px.stop();
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
