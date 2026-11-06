/**
 * K08 - change management: a direct change on production, how the CLI sees
 * it, pulling it back into a migration, the next deploy, and what a new branch
 * is built from.
 *
 * Self-provisioning like K06/K07: a throwaway project in the Team org (prefix
 * PVLAB_PROJECT_PREFIX; `make cm-probe` uses kit-cm-), deleted at the end with
 * its branches. It refuses an adopted project (PVLAB_PEER_MCP), because the
 * flow needs an empty migration history. Needs the `supabase` CLI 3.x
 * (`--remote=<ref>`; the PAT stands in for the database password) and Docker
 * (`db diff` and `db pull` build a shadow database from supabase/migrations).
 *
 * The "repository" is a temp dir: `supabase init`, one migration (an `items`
 * table), pushed with `db push --remote`. Then:
 *   K08.01 hotfix   owner SQL through the Management API SQL route,
 *                   POST /v1/projects/{ref}/database/query: one column, one
 *                   index. NOT the dashboard SQL Editor's own route, which a
 *                   PAT cannot call (bu-attribution BA06); the branching docs
 *                   say SQL Editor changes are tracked, so a hotfix typed into
 *                   the editor may behave differently at K08.02.
 *   K08.02 history  `migration list --remote` after the hotfix: do local and
 *                   remote still agree (no history row for this route)?
 *   K08.03 drift    `db diff --remote` prints the hotfix; exit code recorded.
 *   K08.04 branch, before the pull: a git-less preview branch - does it have
 *                   the unpulled column? Read when its status first reads
 *                   ready, and again at least 60 s and 120 s after create,
 *                   since the parent's schema can arrive well after the status
 *                   flags (branching-nogit).
 *   K08.05 pull     `db pull <name> --remote --yes`: a new migration file with
 *                   both statements, and its version in the remote history.
 *   K08.06 clean    `db diff --remote` after the pull.
 *   K08.07 next     a new migration: `db push --dry-run` lists only it, and
 *                   `db push` applies it.
 *   K08.08 branch, after the pull: the hotfix, the next migration, and the
 *                   versions in its history.
 * Not covered: a GitHub-integration deploy (the connection is dashboard-only),
 * persistent branches, declarative schemas, a hotfix in auth or storage.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { api, provision, sql, teardown, type Scratch } from "../lib/scratch-project";

const TITLE = "Change management: direct production change, drift check, db pull, next deploy, branches";

const HOTFIX = "alter table public.items add column hotfix_note text; create index items_name_idx on public.items (name);";
const COLUMNS_SQL =
  "select coalesce(string_agg(column_name, ',' order by ordinal_position), '') as cols " +
  "from information_schema.columns where table_schema = 'public' and table_name = 'items'";
const HISTORY_SQL =
  "select coalesce(string_agg(version, ',' order by version), '') as versions from supabase_migrations.schema_migrations";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mk(id: string, title: string, ok: boolean | "info", detail?: string, measurements?: Record<string, number | string>, evidence?: string): TestResult {
  return {
    id,
    title,
    status: ok === "info" ? "info" : ok ? "pass" : "fail",
    ...(detail ? { detail } : {}),
    ...(measurements ? { measurements } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

interface Run {
  code: number;
  out: string;
  ms: number;
}

/** Run the CLI in the temp repo with the PAT in the environment; stdin closed, agent mode off. */
async function cli(ctx: Ctx, dir: string, args: string[], timeoutMs = 600_000): Promise<Run> {
  const t0 = Date.now();
  const p = Bun.spawn(["supabase", ...args, "--agent", "no"], {
    cwd: dir,
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  // Docker image pulls are noise in the evidence.
  const text = `${out}\n${err}`
    .split("\n")
    .filter((l) => !/(Pull complete|Pulling fs layer|Verifying Checksum|Download complete|Waiting|Downloading|Extracting|Already exists)/.test(l))
    .join("\n")
    .trim();
  return { code, out: text, ms: Date.now() - t0 };
}

/** `supabase init` does not create supabase/migrations; the first `migration new` does. */
function migrations(dir: string): string[] {
  const d = join(dir, "supabase", "migrations");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".sql")).sort() : [];
}

async function newMigration(ctx: Ctx, dir: string, name: string, body: string): Promise<string> {
  const before = new Set(migrations(dir));
  const r = await cli(ctx, dir, ["migration", "new", name], 60_000);
  const file = migrations(dir).find((f) => !before.has(f));
  if (r.code !== 0 || !file) throw new Error(`migration new ${name}: exit ${r.code} ${r.out.slice(-300)}`);
  writeFileSync(join(dir, "supabase", "migrations", file), body);
  return file;
}

async function one(ctx: Ctx, ref: string, q: string): Promise<Record<string, unknown>> {
  const rows = (await sql(ctx, ref, q)) as Record<string, unknown>[];
  return rows[0] ?? {};
}

interface Branch {
  id: string;
  ref: string;
  /** epoch ms just before the create call */
  createdAt: number;
  /** create to the first status poll reading ready; polls are 10 s apart */
  readyMs: number;
  status: string;
}

/** Create a git-less preview branch and wait until its status reads ready (or failed). */
async function branch(ctx: Ctx, parent: string, name: string): Promise<Branch> {
  const t0 = Date.now();
  const c = await api(ctx, "POST", `/projects/${parent}/branches`, { branch_name: name });
  const j = (c.json ?? {}) as { id?: string; project_ref?: string };
  if (c.status !== 201 || !j.id || !j.project_ref) throw new Error(`branch create: http ${c.status} ${c.text.slice(0, 200)}`);
  let status = "";
  for (let i = 0; i < 90; i++) {
    const l = await api(ctx, "GET", `/projects/${parent}/branches`);
    const b = ((Array.isArray(l.json) ? l.json : []) as { id?: string; status?: string; preview_project_status?: string }[]).find((x) => x.id === j.id);
    status = `${b?.status ?? "?"}/${b?.preview_project_status ?? "?"}`;
    if (/FAILED/.test(status)) break;
    if (b?.status === "FUNCTIONS_DEPLOYED" && b?.preview_project_status === "ACTIVE_HEALTHY") break;
    await sleep(10_000);
  }
  return { id: j.id, ref: j.project_ref, createdAt: t0, readyMs: Date.now() - t0, status };
}

/** A branch's `items` columns and migration history; retries while a fresh branch is still coming up. */
async function branchState(ctx: Ctx, ref: string): Promise<{ cols: string; versions: string }> {
  let last: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      const c = await one(ctx, ref, COLUMNS_SQL);
      const h = await one(ctx, ref, HISTORY_SQL);
      return { cols: String(c.cols ?? ""), versions: String(h.versions ?? "") };
    } catch (e) {
      last = e;
      await sleep(10_000);
    }
  }
  throw last;
}

const mod: TestModule = {
  id: "K08",
  title: TITLE,
  where: "local",
  requires: ["pat"],
  destructive: true, // provisions and deletes its own project and branches
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.team) return [{ id: "K08", title: TITLE, status: "skip", detail: "PVLAB_ORG_TEAM not set" }];
    if (ctx.peers.mcp) return [{ id: "K08", title: TITLE, status: "skip", detail: "K08 needs a fresh project; unset PVLAB_PEER_MCP" }];
    if (!Bun.which("supabase")) return [{ id: "K08", title: TITLE, status: "skip", detail: "supabase CLI not found" }];
    const docker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    if (docker.exitCode !== 0) return [{ id: "K08", title: TITLE, status: "skip", detail: "Docker not running (db diff/pull need a shadow database)" }];

    const results: TestResult[] = [];
    const dir = mkdtempSync(join(tmpdir(), "k08-"));
    const branches: Branch[] = [];
    let s: Scratch | undefined;
    try {
      const ver = await cli(ctx, dir, ["--version"], 30_000);
      s = await provision(ctx, "hotfix", [], (p) => readFileSync(p, "utf8"), false);
      const ref = s.ref;

      // ---- K08.00: the repository and the first deploy ----
      const init = await cli(ctx, dir, ["init"], 60_000);
      if (init.code !== 0) throw new Error(`supabase init: exit ${init.code} ${init.out.slice(-300)}`);
      const m1 = await newMigration(
        ctx,
        dir,
        "create_items",
        "create table public.items (\n  id bigint generated always as identity primary key,\n  name text not null\n);\nalter table public.items enable row level security;\n",
      );
      const push1 = await cli(ctx, dir, ["db", "push", `--remote=${ref}`, "--yes"]);
      const h1 = String((await one(ctx, ref, HISTORY_SQL)).versions ?? "");
      results.push(
        mk("K08.00", "first migration deployed with db push --remote (no --password; the module adds only the PAT to the inherited environment)", push1.code === 0 && h1 === m1.split("_")[0], `exit ${push1.code}; remote history ${h1}`, {
          cli_version: ver.out.split("\n").pop() ?? "",
          push_ms: push1.ms,
        }, push1.out.slice(-1500)),
      );

      // ---- K08.01: the hotfix, through the Management API SQL route (not the SQL Editor route) ----
      const hf = await api(ctx, "POST", `/projects/${ref}/database/query`, { query: HOTFIX });
      const colsAfter = String((await one(ctx, ref, COLUMNS_SQL)).cols ?? "");
      results.push(mk("K08.01", "hotfix applied directly on production (Management API SQL route, owner PAT)", hf.status === 201 && colsAfter.includes("hotfix_note"), `http ${hf.status}; columns ${colsAfter}`));

      // ---- K08.02: migration history does not see it ----
      const list1 = await cli(ctx, dir, ["migration", "list", `--remote=${ref}`], 120_000);
      const h2 = String((await one(ctx, ref, HISTORY_SQL)).versions ?? "");
      results.push(
        mk("K08.02", "migration history after the hotfix", "info", h2 === h1 ? `unchanged (${h2}): local and remote agree, the hotfix is invisible to migration list` : `changed: ${h1} -> ${h2}`, { history_rows: h2 ? h2.split(",").length : 0 }, list1.out.slice(-800)),
      );

      // ---- K08.03: drift check ----
      const diff1 = await cli(ctx, dir, ["db", "diff", `--remote=${ref}`]);
      const sawCol = /hotfix_note/.test(diff1.out);
      const sawIdx = /items_name_idx/.test(diff1.out);
      results.push(
        mk("K08.03", "db diff --remote shows the hotfix", sawCol && sawIdx, `column ${sawCol ? "shown" : "missing"}, index ${sawIdx ? "shown" : "missing"}; exit ${diff1.code}`, { exit_code: diff1.code, diff_ms: diff1.ms }, diff1.out.slice(-1500)),
      );

      // ---- K08.04: a branch created before the pull, read three times ----
      const b1 = await branch(ctx, ref, "k08-before-pull");
      branches.push(b1);
      const reads: string[] = [];
      const st1 = await branchState(ctx, b1.ref);
      reads.push(`at ready (${Math.round(b1.readyMs / 1000)} s): ${st1.cols.includes("hotfix_note") ? "HAS" : "LACKS"} hotfix_note, columns ${st1.cols}, history ${st1.versions}`);
      let last = st1;
      for (const atS of [60, 120]) {
        const wait = b1.createdAt + atS * 1000 - Date.now();
        if (wait > 0) await sleep(wait);
        last = await branchState(ctx, b1.ref);
        reads.push(`at ${Math.round((Date.now() - b1.createdAt) / 1000)} s: ${last.cols.includes("hotfix_note") ? "HAS" : "LACKS"} hotfix_note, columns ${last.cols}, history ${last.versions}`);
      }
      results.push(
        mk("K08.04", "git-less preview branch created before the pull: has the unpulled hotfix? (three reads)", "info", `${reads.join("; ")}; branch ${b1.status}`, {
          branch_status_ready_ms: b1.readyMs,
          last_read_s: Math.round((Date.now() - b1.createdAt) / 1000),
          has_hotfix_at_last_read: last.cols.includes("hotfix_note") ? 1 : 0,
        }),
      );

      // ---- K08.05: pull the hotfix into a migration ----
      const before = new Set(migrations(dir));
      const pull = await cli(ctx, dir, ["db", "pull", "hotfix_items", `--remote=${ref}`, "--yes"]);
      const added = migrations(dir).filter((f) => !before.has(f));
      const body = added[0] ? readFileSync(join(dir, "supabase", "migrations", added[0]), "utf8") : "";
      const h3 = String((await one(ctx, ref, HISTORY_SQL)).versions ?? "");
      const pulledVer = added[0]?.split("_")[0] ?? "";
      const pullOk = pull.code === 0 && added.length === 1 && /hotfix_note/.test(body) && /items_name_idx/.test(body) && h3.split(",").includes(pulledVer);
      results.push(
        mk("K08.05", "db pull --remote writes the hotfix as a migration and records it applied", pullOk, `exit ${pull.code}; ${added.length} new file(s); remote history ${h3}`, { pull_ms: pull.ms, new_files: added.length }, `${pull.out.slice(-1200)}\n--- ${added[0] ?? "(none)"} ---\n${body}`),
      );

      // ---- K08.06: drift check after the pull ----
      const diff2 = await cli(ctx, dir, ["db", "diff", `--remote=${ref}`]);
      results.push(
        mk("K08.06", "db diff --remote after the pull reports no changes", /No schema changes found/.test(diff2.out), `exit ${diff2.code}`, { exit_code: diff2.code }, diff2.out.slice(-600)),
      );

      // ---- K08.07: the next ordinary change ----
      const m3 = await newMigration(ctx, dir, "add_owner_dept", "alter table public.items add column owner_dept text;\n");
      const dry = await cli(ctx, dir, ["db", "push", `--remote=${ref}`, "--dry-run"], 240_000);
      const listed = (dry.out.match(/\d{14}_[a-z_]+\.sql/g) ?? []).filter((x, i, a) => a.indexOf(x) === i);
      const push2 = await cli(ctx, dir, ["db", "push", `--remote=${ref}`, "--yes"], 240_000);
      const cols2 = String((await one(ctx, ref, COLUMNS_SQL)).cols ?? "");
      results.push(
        mk("K08.07", "next migration: dry run lists only it, push applies it", listed.length === 1 && listed[0] === m3 && push2.code === 0 && cols2.includes("owner_dept"), `dry run listed ${listed.join(",") || "nothing"}; push exit ${push2.code}`, { dry_run_listed: listed.length }, `${dry.out.slice(-600)}\n---\n${push2.out.slice(-600)}`),
      );

      // ---- K08.08: a branch created after the pull ----
      const b2 = await branch(ctx, ref, "k08-after-pull");
      branches.push(b2);
      const st2 = await branchState(ctx, b2.ref);
      const h4 = String((await one(ctx, ref, HISTORY_SQL)).versions ?? "");
      results.push(
        mk("K08.08", "preview branch created after the pull: hotfix and next migration present, same history", st2.cols.includes("hotfix_note") && st2.cols.includes("owner_dept") && st2.versions === h4, `columns ${st2.cols}; branch history ${st2.versions}; production history ${h4}`, { branch_status_ready_ms: b2.readyMs }),
      );
    } catch (e) {
      results.push(mk("K08.99", "aborted", false, (e as Error).message));
    } finally {
      const deletes: string[] = [];
      for (const b of branches) {
        const d = await api(ctx, "DELETE", `/branches/${b.id}`).catch(() => undefined);
        deletes.push(String(d?.status ?? "n/a"));
        ctx.log(`branch ${b.id} delete: http ${d?.status ?? "n/a"}`);
      }
      const note = await teardown(ctx, s).catch((e) => `teardown error: ${(e as Error).message}`);
      ctx.log(`teardown: ${note}`);
      results.push(mk("K08.teardown", "branches and project removed", "info", `branch deletes http ${deletes.join(",") || "none"}; ${note}`));
      rmSync(dir, { recursive: true, force: true });
    }
    return results;
  },
};

export default mod;
