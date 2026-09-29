/**
 * GB07 - where a preview branch's secrets come from.
 *
 * The branching configuration docs (read 2026-09-29) make three claims a team
 * relies on once more than one person ships previews:
 *
 *   1. "Secrets set for one branch are not automatically available in other
 *      branches."
 *   2. A committed `supabase/.env.preview`, encrypted with dotenvx, is
 *      decrypted by the branching executor "automatically", given the
 *      private key from `.env.keys` set as a project secret.
 *   3. `config.toml` reads secrets through `env(NAME)`.
 *
 * None says what a preview gets when an `env()` reference has no value
 * anywhere, or when `.env.preview` was encrypted with a key the project does
 * not hold. Those are the two ways a preview silently runs with the wrong
 * secret. This module opens one pull request per shape, all under
 * apps/a/supabase/ (project A's workdir), all at once:
 *
 *   inherit   a probe function only; PVLAB_GB07_PARENT is set on parent A
 *   dotenvx   + .env.preview holding PVLAB_GB07_DOTENV, encrypted with the
 *             keypair whose private half is set on parent A as
 *             DOTENV_PRIVATE_KEY_PREVIEW; config.toml maps it through env()
 *   wrongkey  as dotenvx, but .env.preview encrypted with a second keypair
 *             whose private half is thrown away (PVLAB_GB07_WRONGKEY)
 *   unset     config.toml maps PVLAB_GB07_UNSET through env(), no value
 *             anywhere
 *
 * Every shape declares `[functions.secretprobe]` (GB04: only functions
 * declared in config.toml deploy to branches) with verify_jwt off, and the
 * function reports, per name, absent | empty | literal-env | encrypted-literal
 * | value, with a SHA-256 of a present value. The module compares that digest
 * locally, so no value leaves the function and none is recorded.
 *
 * Two readings per shape, because they can disagree: what the preview's
 * GET /v1/projects/{preview}/secrets lists (the spec calls the field `value`
 * without saying whether it is the value or a digest; the parent-side
 * control below classifies it), and what the function sees at runtime.
 *
 * Control: the same list call on parent A right after the setup POST, so
 * "listed as sha256" versus "listed as plaintext" is measured on a value the
 * module knows, before any preview reading depends on it.
 *
 * DESTRUCTIVE: two secrets on parent A (deleted in finally), git branches,
 * pull requests, billed preview branches. Cleanup as GB01.
 *
 * Not settled by this module: `encrypted:` literals directly in config.toml
 * (the docs' Option A); `[remotes.<name>]` blocks on persistent branches;
 * `[db.vault]` secrets; whether a later `supabase secrets set` on the parent
 * reaches an already-open preview.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import {
  actionRuns,
  branchWithFiles,
  closePr,
  connections,
  deleteBranch,
  ghApi,
  openPr,
  orgSlugOf,
  previewBranches,
  repoOf,
  sleep,
} from "../lib/gh.js";
import { dotenvxFile, listedClass, listSecrets, N, PROBE_FN, PROBED, sha256, terminal, throwaway } from "../lib/secrets.js";

const ID = "GB07";
const TITLE = "preview-branch secrets: parent carry-over, dotenvx, wrong key, unset env()";
const WINDOW_MS = 12 * 60_000;
const POLL_MS = 20_000;
const PROBE_RETRY_MS = 2 * 60_000;
const SETTLE_AFTER_CLOSE_MS = 2 * 60_000;

interface Obs {
  git: string;
  pr: number;
  preview: string;
  status: string[];
  steps: string;
  doneS: number;
}

const mod: TestModule = {
  id: ID,
  title: TITLE,
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult> {
    const repo = repoOf(ctx);
    if (!repo) return { id: ID, title: TITLE, status: "skip", detail: "no PVLAB_ENDPOINT_REPO (owner/name)" };
    const a = ctx.ref;
    const conn = (await connections(ctx, await orgSlugOf(ctx, a))).rows.find((c) => c.project_ref === a);
    if (!conn) return { id: ID, title: TITLE, status: "skip", detail: "project A has no GitHub connection" };

    // Values exist only in this process; nothing below logs or records them.
    const v = { parent: throwaway(), dotenv: throwaway(), wrongkey: throwaway() };
    const good = dotenvxFile(N.dotenv, v.dotenv);
    const bad = dotenvxFile(N.wrongkey, v.wrongkey); // its private key is dropped here
    const expected: Record<string, string> = { [N.parent]: v.parent, [N.dotenv]: v.dotenv, [N.wrongkey]: v.wrongkey, [N.key]: good.privateKey };

    const obs: Record<string, Obs> = {};
    const m: Record<string, string | number> = { toggle_changes_only: String(conn.supabase_changes_only), window_s: WINDOW_MS / 1000 };
    const evidence: Record<string, unknown> = {};
    try {
      const set = await mgmt(ctx, "POST", `/projects/${a}/secrets`, [
        { name: N.parent, value: v.parent },
        { name: N.key, value: good.privateKey },
      ]);
      if (set.status >= 300) return { id: ID, title: TITLE, status: "fail", detail: `setting parent secrets: HTTP ${set.status}` };
      const parentList = await listSecrets(ctx, a);
      m.control_parent_listed_as = listedClass(parentList.get(N.parent), v.parent);

      const cfgPath = "apps/a/supabase/config.toml";
      const base = ghApi("GET", `repos/${repo}/contents/${cfgPath}?ref=main`);
      const config = Buffer.from(String((base.json as { content?: string })?.content ?? ""), "base64").toString("utf8");
      const fnTable = `\n[functions.secretprobe]\nverify_jwt = false\n`;
      const envTable = (name: string) => `\n[edge_runtime.secrets]\n${name} = "env(${name})"\n`;
      const fn = { "apps/a/supabase/functions/secretprobe/index.ts": PROBE_FN };
      const shapes: Record<string, Record<string, string>> = {
        inherit: { ...fn, [cfgPath]: config + fnTable },
        dotenvx: { ...fn, [cfgPath]: config + fnTable + envTable(N.dotenv), "apps/a/supabase/.env.preview": good.envPreview },
        wrongkey: { ...fn, [cfgPath]: config + fnTable + envTable(N.wrongkey), "apps/a/supabase/.env.preview": bad.envPreview },
        unset: { ...fn, [cfgPath]: config + fnTable + envTable(N.unset) },
      };

      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const t0 = Date.now();
      for (const [shape, files] of Object.entries(shapes)) {
        const git = `gb07-${stamp}-${shape}`;
        branchWithFiles(repo, "main", git, files, `probe: branch secrets, ${shape}`);
        const pr = openPr(repo, git, "main", `GB07 ${shape} (${stamp})`);
        obs[shape] = { git, pr, preview: "", status: [], steps: "", doneS: -1 };
        ctx.log(`${shape}: PR #${pr} on ${git}`);
      }

      // FUNCTIONS_DEPLOYED shows up before CREATING_PROJECT (GB03), so
      // readiness is the preview's latest action run reaching a terminal state.
      while (Date.now() - t0 < WINDOW_MS && Object.values(obs).some((o) => o.doneS < 0)) {
        await sleep(POLL_MS);
        const s = Math.round((Date.now() - t0) / 1000);
        const rows = await previewBranches(ctx, a);
        for (const o of Object.values(obs)) {
          if (o.doneS >= 0) continue;
          const br = rows.find((b) => b.git_branch === o.git);
          if (br?.project_ref) o.preview = br.project_ref;
          const st = br?.status || "absent";
          if (o.status.at(-1)?.endsWith(`=${st}`) !== true) o.status.push(`${s}s=${st}`);
          if (!o.preview) continue;
          const latest = (await actionRuns(ctx, o.preview)).sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
          o.steps = latest?.steps ?? "";
          if (terminal(o.steps)) o.doneS = s;
        }
      }

      const lines: string[] = [];
      for (const [shape, o] of Object.entries(obs)) {
        const listed = o.preview ? await listSecrets(ctx, o.preview) : new Map<string, string>();
        let runtime: Record<string, { cls: string; len: number; sha256: string }> = {};
        let fnStatus = 0;
        if (o.preview) {
          const until = Date.now() + PROBE_RETRY_MS;
          while (Date.now() < until) {
            const r = await fetch(`https://${o.preview}.supabase.co/functions/v1/secretprobe`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
            fnStatus = r?.status ?? 0;
            if (r?.ok) {
              runtime = (await r.json().catch(() => ({}))) as typeof runtime;
              break;
            }
            await sleep(10_000);
          }
        }
        const per: Record<string, string> = {};
        for (const n of PROBED) {
          const rt = runtime[n];
          const rtClass = !rt ? "no-reading" : rt.cls !== "value" ? rt.cls : expected[n] !== undefined && rt.sha256 === sha256(expected[n]!) ? "value=set" : "value=other";
          per[n] = `list:${listedClass(listed.get(n), expected[n])} runtime:${rtClass}`;
        }
        const tag = (n: string) => per[n]!;
        m[`${shape}_status`] = o.status.at(-1)?.replace(/^\d+s=/, "") ?? "absent";
        m[`${shape}_steps`] = o.steps || "none";
        m[`${shape}_ready_s`] = o.doneS;
        m[`${shape}_fn_http`] = fnStatus;
        m[`${shape}_parent`] = tag(N.parent);
        m[`${shape}_dotenv_key`] = tag(N.key);
        if (shape === "dotenvx") m.dotenvx_value = tag(N.dotenv);
        if (shape === "wrongkey") m.wrongkey_value = tag(N.wrongkey);
        if (shape === "unset") m.unset_value = tag(N.unset);
        evidence[shape] = {
          pr: o.pr,
          status_sequence: o.status,
          steps: o.steps,
          fn_http: fnStatus,
          // Names only: the platform's SUPABASE_* entries plus whatever carried.
          listed_names: [...listed.keys()].sort(),
          per_name: per,
        };
        lines.push(`${shape}: ${m[`${shape}_status`]}, fn ${fnStatus}`);
      }

      return {
        id: ID,
        title: TITLE,
        status: "info",
        detail: `control: parent lists its secret as ${m.control_parent_listed_as}. ${lines.join("; ")}. Per-name readings in measurements.`,
        measurements: m,
        evidence: JSON.stringify(evidence, null, 2),
      };
    } finally {
      for (const o of Object.values(obs)) {
        closePr(repo, o.pr);
        deleteBranch(repo, o.git);
      }
      if (Object.keys(obs).length) {
        await sleep(SETTLE_AFTER_CLOSE_MS);
        const gits = new Set(Object.values(obs).map((o) => o.git));
        for (const b of (await previewBranches(ctx, a)).filter((b) => gits.has(b.git_branch))) await mgmt(ctx, "DELETE", `/branches/${b.id}`);
      }
      await mgmt(ctx, "DELETE", `/projects/${a}/secrets`, [N.parent, N.key]);
    }
  },
};
export default mod;
