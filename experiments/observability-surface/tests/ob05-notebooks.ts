/**
 * OB05 - notebooks: the `supabase notebooks pull` / `push` round trip against
 * the v2 notebooks API (`/v2/projects/{ref}/notebooks`).
 *
 * Claims under test (CLI help text read on the installed CLI, and the v2
 * OpenAPI document): `pull` writes project notebooks to
 * `supabase/notebooks/<name>.json`, keeping existing local files unless an id
 * is given; `push` writes local files to the project and "asks what to do
 * about project notebooks the directory does not have"; an update replaces the
 * body, a cell keeps its identity by echoing its `id`, a cell sent without an
 * `id` is added as a new one.
 *
 * Rows:
 *   OB05a  create a notebook through the API with a markdown, a database and a
 *          log cell; GET it back (cell ids assigned by the server).
 *   OB05b  `pull --project-ref`: which file appears, its name, and whether its
 *          cells equal the API's.
 *   OB05c  edit the file (change one cell's sql, append a cell with no id),
 *          `push`: API content afterwards, ids kept or new, `updated_by`.
 *   OB05d  a second `pull` on an unchanged tree, then `pull <id>` after a
 *          local edit (replace).
 *   OB05e  a new local notebook file pushed: created on the project?
 *   OB05f  delete a local file the project still has and `push --yes`: is the
 *          project notebook deleted, kept, or does the CLI refuse?
 *
 * The CLI runs with the PAT in its environment, in a temporary working
 * directory (`--workdir`), non-interactively (`--yes`; stdin closed). Not
 * settled: the interactive prompt of OB05f (a closed stdin cannot answer it),
 * notebooks with a read replica `database_identifier`, running a notebook (no
 * run endpoint is in the v2 OpenAPI document).
 *
 * DESTRUCTIVE: creates and deletes one project (notebooks are removed with it).
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { dropProject, makeProject } from "../lib/ob";

const V2 = (process.env.SUPABASE_MGMT_BASE_URL ?? "https://api.supabase.com/v1").replace(/\/v1$/, "");

type Cell = Record<string, unknown> & { id?: string; type: string };
interface Nb {
  id: string;
  attributes: { name: string; content: { cells: Cell[] }; updated_by?: { username?: string } | null; owner?: { username?: string } | null };
}

async function api(ctx: Ctx, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${V2}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.pat}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const list = async (ctx: Ctx): Promise<Nb[]> => ((await api(ctx, "GET", `/v2/projects/${ctx.ref}/notebooks`)).json as { data?: Nb[] } | undefined)?.data ?? [];
const get = async (ctx: Ctx, id: string): Promise<Nb | undefined> => ((await api(ctx, "GET", `/v2/projects/${ctx.ref}/notebooks/${id}`)).json as { data?: Nb } | undefined)?.data;

async function cli(ctx: Ctx, dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["supabase", ...args, "--workdir", dir, "--yes"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SUPABASE_ACCESS_TOKEN: ctx.pat ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const text = `${o}${e}`.replaceAll(ctx.ref, "<ref>").replaceAll(dir, "<tmp>").replace(/\s+/g, " ").trim();
  return { code: p.exitCode ?? -1, out: text.slice(0, 300) };
}

const files = (dir: string) => {
  try {
    return readdirSync(join(dir, "supabase", "notebooks")).sort();
  } catch {
    return [] as string[];
  }
};
const sig = (cells: Cell[]) => cells.map((c) => `${c.type}:${String(c.sql ?? c.text ?? "").slice(0, 30)}`).join("|");

const mod: TestModule = {
  id: "OB05",
  title: "Notebooks: supabase notebooks pull/push round trip against the v2 API",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "OB05", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    if (!Bun.which("supabase")) return [{ id: "OB05", title: this.title, status: "skip", detail: "supabase CLI not on PATH" }];
    const out: TestResult[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ob05-"));
    let ref = "";
    try {
      const ver = Bun.spawnSync(["supabase", "--version"]).stdout.toString().trim();
      const proj = await makeProject(ctx, "ob05");
      ref = proj.ref;
      const pc = proj.ctx;
      mkdirSync(join(dir, "supabase"), { recursive: true });
      writeFileSync(join(dir, "supabase", "config.toml"), `project_id = "ob05"\n`);

      // a
      const created = await api(pc, "POST", `/v2/projects/${ref}/notebooks`, {
        data: {
          type: "notebook",
          attributes: {
            name: "ob05-alpha",
            description: "round trip",
            content: {
              cells: [
                { type: "markdown", text: "# ob05" },
                { type: "database", sql: "select 1 as one", row_limit: 10, title: "one" },
                { type: "log", sql: "select source, count(*) as n from logs group by source", time_range: { type: "relative", unit: "hour", amount: 1 }, title: "sources" },
              ],
            },
          },
        },
      });
      const nbId = (created.json as { data?: { id?: string } } | undefined)?.data?.id ?? "";
      const first = nbId ? await get(pc, nbId) : undefined;
      out.push({
        id: "OB05a",
        title: "OB05a: create a notebook with markdown, database and log cells through the API",
        status: created.status === 201 && first ? "pass" : "fail",
        detail: created.status === 201 ? undefined : `HTTP ${created.status}: ${created.text.slice(0, 300)}`,
        measurements: {
          create_status: created.status,
          cells: first?.attributes.content.cells.length ?? -1,
          ids_assigned: String(first?.attributes.content.cells.every((c) => !!c.id) ?? false),
          cli_version: ver,
        },
      });
      if (!first) return out;

      // b
      const pull1 = await cli(pc, dir, ["notebooks", "pull", "--project-ref", ref]);
      const f1 = files(dir);
      let localEqual = "n/a";
      let localKeys = "";
      if (f1[0]) {
        const loc = JSON.parse(readFileSync(join(dir, "supabase", "notebooks", f1[0]), "utf8")) as Record<string, unknown>;
        localKeys = Object.keys(loc).join(",");
        const cells = ((loc.content as { cells?: Cell[] } | undefined)?.cells ?? (loc.cells as Cell[] | undefined) ?? []) as Cell[];
        localEqual = String(sig(cells) === sig(first.attributes.content.cells));
      }
      out.push({
        id: "OB05b",
        title: "OB05b: pull writes the project notebook to supabase/notebooks/",
        status: pull1.code === 0 && f1.length === 1 ? "pass" : "fail",
        detail: pull1.out,
        measurements: { exit: pull1.code, files: f1.join(","), top_level_keys: localKeys, cells_equal_api: localEqual },
      });
      if (!f1[0]) return out;

      // c: edit and push
      const path1 = join(dir, "supabase", "notebooks", f1[0]);
      const loc = JSON.parse(readFileSync(path1, "utf8")) as Record<string, unknown>;
      const holder = (loc.content as { cells?: Cell[] } | undefined)?.cells ? (loc.content as { cells: Cell[] }) : (loc as unknown as { cells: Cell[] });
      const db = holder.cells.find((c) => c.type === "database");
      if (db) db.sql = "select 2 as two";
      holder.cells.push({ type: "markdown", text: "appended locally" });
      writeFileSync(path1, JSON.stringify(loc, null, 2));
      const push1 = await cli(pc, dir, ["notebooks", "push", "--project-ref", ref]);
      const after = await get(pc, nbId);
      const idsBefore = first.attributes.content.cells.map((c) => c.id);
      const idsAfter = after?.attributes.content.cells.map((c) => c.id) ?? [];
      out.push({
        id: "OB05c",
        title: "OB05c: push an edited file (one sql changed, one cell appended without id)",
        status: push1.code === 0 && after?.attributes.content.cells.length === 4 ? "pass" : "fail",
        detail: push1.out,
        measurements: {
          exit: push1.code,
          cells_after: after?.attributes.content.cells.length ?? -1,
          edited_sql_after: String(after?.attributes.content.cells.find((c) => c.type === "database")?.sql ?? "-"),
          original_ids_kept: String(idsBefore.every((i) => idsAfter.includes(i))),
          new_cell_has_id: String(!!idsAfter[3]),
          updated_by: after?.attributes.updated_by?.username ? "present" : "absent",
          notebooks_on_project: (await list(pc)).length,
        },
      });

      // d: pull again, then pull <id> after a local edit
      const pull2 = await cli(pc, dir, ["notebooks", "pull", "--project-ref", ref]);
      const sameFiles = files(dir).join(",") === f1.join(",");
      writeFileSync(path1, JSON.stringify({ ...loc, name: "local-scribble" }, null, 2));
      const pull3 = await cli(pc, dir, ["notebooks", "pull", "--project-ref", ref, nbId]);
      const restored = JSON.parse(readFileSync(path1, "utf8")) as Record<string, unknown>;
      out.push({
        id: "OB05d",
        title: "OB05d: pull on an unchanged tree, then pull <id> over a locally edited file",
        status: pull2.code === 0 && pull3.code === 0 ? "info" : "fail",
        detail: `${pull2.out} || ${pull3.out}`,
        measurements: { second_pull_exit: pull2.code, second_pull_same_files: String(sameFiles), id_pull_exit: pull3.code, id_pull_replaced_local_edit: String(restored.name !== "local-scribble") },
      });

      // e: new local notebook
      const second = { ...JSON.parse(JSON.stringify(restored)), name: "ob05-beta" } as Record<string, unknown>;
      delete second.id;
      writeFileSync(join(dir, "supabase", "notebooks", "ob05-beta.json"), JSON.stringify(second, null, 2));
      const push2 = await cli(pc, dir, ["notebooks", "push", "--project-ref", ref]);
      const afterE = await list(pc);
      out.push({
        id: "OB05e",
        title: "OB05e: a new local notebook file is created on the project by push",
        status: push2.code === 0 && afterE.some((n) => n.attributes.name === "ob05-beta") ? "pass" : "fail",
        detail: push2.out,
        measurements: { exit: push2.code, names_on_project: afterE.map((n) => n.attributes.name).sort().join(",") },
      });

      // f: local file removed, project still has the notebook
      rmSync(path1);
      const push3 = await cli(pc, dir, ["notebooks", "push", "--project-ref", ref]);
      const afterF = await list(pc);
      out.push({
        id: "OB05f",
        title: "OB05f: push --yes with a project notebook the directory does not have",
        status: "info",
        detail: push3.out,
        measurements: { exit: push3.code, alpha_still_on_project: String(afterF.some((n) => n.id === nbId)), names_on_project: afterF.map((n) => n.attributes.name).sort().join(",") },
      });
    } catch (e) {
      out.push({ id: "OB05", title: "OB05", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await dropProject(ctx, ref);
    }
    return out;
  },
};
export default mod;
