/**
 * CL04 - the CLI against a linked hosted project: `config pull`, `pull`, and
 * `db diff --linked` under both engines.
 *
 * Source for the claim (Select 2026 notes, supabase.com/changelog entry 44938
 * for pg-delta): `supabase config pull` brings dashboard-side configuration
 * into `config.toml`, `supabase pull` refreshes config, migration history,
 * schema and functions in one step. The probe: change an auth
 * provider, an API limit and a bucket in the dashboard, then pull and diff.
 * The dashboard calls the Management API and the Storage API; this module
 * makes the same changes through those APIs (the dashboard itself is not
 * driven, so a dashboard-only code path would not be exercised).
 *
 *   CL04a  config pull against a brand-new project and a freshly initialised
 *          local project: how many differences, which are written, which are
 *          skipped, what is declared but not compared; then the same pull
 *          again after the write (what remains).
 *   CL04b  after changes through the APIs - GitHub OAuth provider enabled with
 *          a client id and secret, anonymous sign-ins on, PostgREST max_rows,
 *          storage global file size limit, one storage bucket with a size
 *          limit and a MIME allow-list - the dry-run diff and the written
 *          config.toml, key by key.
 *   CL04c  `db diff --linked` on the project with the fixture applied remotely:
 *          `--use-migra` against `--use-pg-delta`.
 *   CL04d  `supabase pull --yes`: files written, then the pulled migrations
 *          applied to a local database and fingerprinted against the remote
 *          catalogs (the same query, run through the Management API).
 *
 * Destructive: creates one Free-org project named `pvlab-cli-cfg-<ts>` and deletes
 * it in `finally`. Needs PVLAB_ORG_FREE, a PAT, Docker.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { sql } from "../../../harness/src/platform.js";
import dns from "node:dns/promises";
import { cliVersion, dockerReachable, noCli, stamp, initLocalProject, quiet, saveRaw, scrub, stopLocal, tail, type LocalProject } from "../lib/cli";
import { countByKind, diffFingerprints, fingerprint, fingerprintSql } from "../lib/fingerprint";
import { FIXTURE_SQL, diffSql, featureCoverage, listFiles } from "../lib/fixture";
import { createProject, deleteProject, parseConfigDiff, remoteSql, serviceKey, type RemoteProject } from "../lib/remote";
import { rmSync as rm } from "node:fs";
import { dirname } from "node:path";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const summaryNums = (s: string) => {
  const m = s.match(/(\d+) differences? found \((\d+) to write, (\d+) to skip\)/);
  return { total: Number(m?.[1] ?? -1), write: Number(m?.[2] ?? -1), skip: Number(m?.[3] ?? -1) };
};

const mod: TestModule = {
  id: "CL04",
  title: "Linked project: config pull, pull, db diff --linked (migra vs pg-delta)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const org = ctx.orgs.free;
    if (!org) return [{ id: "CL04", title: this.title, status: "skip", detail: "no PVLAB_ORG_FREE" }];
    if (!(await dockerReachable())) return [{ id: "CL04", title: this.title, status: "skip", detail: "no Docker daemon reachable from this vantage" }];
    const ver = await cliVersion();
    if (ver === "absent") return [noCli("CL04", this.title)];
    const out: TestResult[] = [];
    let remote: RemoteProject | undefined;
    let local: LocalProject | undefined;
    let deleted = false;
    try {
      remote = await createProject(ctx, org, "cfg");
      ctx.log(`cl04: project created in ${remote.createdMs} ms, healthy after ${remote.healthyMs} ms`);
      const rp = remote;
      local = await initLocalProject("cl04", 4);
      const L = local;
      const auth = { SUPABASE_ACCESS_TOKEN: ctx.pat, SUPABASE_DB_PASSWORD: rp.dbPass };
      const sbx = (args: string[], timeoutMs = 600_000) => L.sb(args, { env: auth, timeoutMs });
      const cfgPath = join(L.dir, "supabase", "config.toml");
      // the CLI's own port block must not collide with anything else running
      const linkRes = await sbx(["link", "--project-ref", rp.ref, "--yes"]);

      // ---------------- CL04a ----------------
      const dry0 = await sbx(["config", "pull", "--project-ref", rp.ref, "--dry-run", "--output-format", "text"]);
      const hashBefore = sha(readFileSync(cfgPath, "utf8"));
      const p0 = parseConfigDiff(dry0.all);
      const hashAfterDry = sha(readFileSync(cfgPath, "utf8"));
      const w0 = await sbx(["config", "pull", "--project-ref", rp.ref, "--yes", "--output-format", "text"]);
      const dry1 = await sbx(["config", "pull", "--project-ref", rp.ref, "--dry-run", "--output-format", "text"]);
      const p1 = parseConfigDiff(dry1.all);
      const tagCount = (es: typeof p0.entries) => {
        const c: Record<string, number> = {};
        for (const e of es) for (const t of e.tags) c[t.split(":")[0]!] = (c[t.split(":")[0]!] ?? 0) + 1;
        return JSON.stringify(c);
      };
      saveRaw("cl04a-dry-run-first.txt", scrub(dry0.all));
      saveRaw("cl04a-dry-run-after-write.txt", scrub(dry1.all));
      out.push({
        id: "CL04a",
        title: "config pull on a new project vs a freshly initialised local config",
        status: dry0.code === 0 && w0.code === 0 ? "info" : "fail",
        detail: `link exit ${linkRes.code}; first dry-run ${p0.summary || tail(dry0.all, 1)}; after the write ${p1.summary || "no differences line"}; dry-run changed the file: ${hashBefore !== hashAfterDry}`,
        measurements: {
          link_exit: linkRes.code,
          dry_run_exit: dry0.code,
          dry_run_ms: dry0.ms,
          write_exit: w0.code,
          first_differences: summaryNums(p0.summary).total,
          first_to_write: summaryNums(p0.summary).write,
          first_to_skip: summaryNums(p0.summary).skip,
          first_entries_by_tag: tagCount(p0.entries),
          first_keys: p0.entries.map((e) => e.key).join(","),
          comparison_scope: p0.scope.replace(/^Comparison scope: /, ""),
          not_compared_note: p0.notes.map((n) => n.replace(/^Note: /, "")).join(" || ").slice(0, 600),
          dry_run_changed_config: hashBefore !== hashAfterDry ? 1 : 0,
          after_write_differences: summaryNums(p1.summary).total,
          after_write_to_write: summaryNums(p1.summary).write,
          after_write_keys: p1.entries.map((e) => `${e.key}[${e.tags.join(";")}]`).join(","),
        },
        evidence: tail(scrub(dry1.all), 12),
      });

      // ---------------- CL04b ----------------
      const keyOf = (name: string) => `https://${rp.ref}.supabase.co${name}`;
      const svc = await serviceKey(rp);
      const changes: Record<string, number | string> = {};
      const authPatch = await mgmt(ctx, "PATCH", `/projects/${rp.ref}/config/auth`, {
        external_github_enabled: true,
        external_github_client_id: "cl-test-client-id",
        external_github_secret: "cl-test-secret-value",
        external_anonymous_users_enabled: true,
      });
      changes.auth_patch_status = authPatch.status;
      const pgrst = await mgmt(ctx, "PATCH", `/projects/${rp.ref}/postgrest`, { max_rows: 777 });
      changes.postgrest_patch_status = pgrst.status;
      const stor = await mgmt(ctx, "PATCH", `/projects/${rp.ref}/config/storage`, { fileSizeLimit: 12345678 });
      changes.storage_patch_status = stor.status;
      const bucket = await fetch(keyOf("/storage/v1/bucket"), {
        method: "POST",
        headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "cl-bucket", public: true, file_size_limit: 1048576, allowed_mime_types: ["image/png"] }),
      });
      changes.bucket_create_status = bucket.status;
      const dry2 = await sbx(["config", "pull", "--project-ref", rp.ref, "--dry-run", "--output-format", "text"]);
      const p2 = parseConfigDiff(dry2.all);
      const ent = (re: RegExp) => p2.entries.find((e) => re.test(e.key));
      const fmt = (e?: { tags: string[]; local: string; remote: string }) => (e ? `${e.tags.join(";")} local=${e.local} remote=${e.remote}` : "not listed");
      const w2 = await sbx(["config", "pull", "--project-ref", rp.ref, "--yes", "--output-format", "text"]);
      const toml = readFileSync(cfgPath, "utf8");
      const line = (re: RegExp) => (toml.split("\n").find((l) => re.test(l)) ?? "absent").trim();
      saveRaw("cl04b-dry-run-after-changes.txt", scrub(dry2.all));
      out.push({
        id: "CL04b",
        title: "config pull after provider, API limit and bucket changes made through the APIs",
        status: "info",
        detail: `github enabled: ${fmt(ent(/external\.github\.enabled/))}; max_rows: ${fmt(ent(/api\.max_rows/))}; bucket: ${/\[storage\.buckets\.cl-bucket\]/.test(toml) ? "written" : "not in config.toml"}`,
        measurements: {
          ...changes,
          dry_run_exit: dry2.code,
          write_exit: w2.code,
          github_enabled_entry: fmt(ent(/external\.github\.enabled/)),
          github_client_id_entry: fmt(ent(/external\.github\.client_id/)),
          github_secret_entry: fmt(ent(/external\.github\.secret/)),
          github_warning: (dry2.all.match(/auth\.external\.github was not changed[^\n]*/)?.[0] ?? "none").slice(0, 200),
          anonymous_sign_ins_entry: fmt(ent(/enable_anonymous_sign_ins/)),
          max_rows_entry: fmt(ent(/api\.max_rows/)),
          file_size_entry: fmt(ent(/storage\.file_size_limit/)),
          bucket_entry: fmt(p2.entries.find((e) => /buckets/.test(e.key))),
          toml_github_enabled: line(/^enabled = true/ ).length > 0 && /\[auth\.external\.github\]/.test(toml) ? "section present" : "section absent",
          toml_anonymous_line: line(/enable_anonymous_sign_ins/),
          toml_max_rows_line: line(/^max_rows/),
          toml_file_size_line: line(/^file_size_limit/),
          toml_bucket_section: /\[storage\.buckets\.cl-bucket\]/.test(toml) ? "present" : "absent",
          differences_listed: summaryNums(p2.summary).total,
          to_write: summaryNums(p2.summary).write,
          to_skip: summaryNums(p2.summary).skip,
        },
        evidence: tail(scrub(dry2.all), 14),
      });

      // ---------------- CL04c: linked diff, both engines ----------------
      const rs = await remoteSql(rp, FIXTURE_SQL);
      // Name resolution for the direct DB host from this vantage, recorded because
      // the migra engine connects to it directly (CL04c finding on the first run).
      const dbHost = `db.${rp.ref}.supabase.co`;
      const aRecs = await dns.resolve4(dbHost).catch((e: { code?: string }) => e.code ?? "error");
      const aaaaRecs = await dns.resolve6(dbHost).catch((e: { code?: string }) => e.code ?? "error");
      const diffs: Record<string, { code: number; ms: number; firstMs: number; sql: string; err: string }> = {};
      for (const [name, flag] of [["migra", "--use-migra"], ["pgdelta", "--use-pg-delta"]] as const) {
        // two runs: the first may pull the shadow-database image for the remote's Postgres version
        const first = await sbx(["db", "diff", "--linked", flag, "--output-format", "json"]);
        const r = await sbx(["db", "diff", "--linked", flag, "--output-format", "json"]);
        const d = diffSql(r);
        diffs[name] = { code: r.code, ms: r.ms, firstMs: first.ms, sql: d.sql, err: r.code !== 0 ? scrub(r.stdout || r.stderr).replace(/\s+/g, " ").slice(0, 260) : "" };
        saveRaw(`cl04c-linked-${name}.sql`, d.sql);
        saveRaw(`cl04c-linked-${name}.stderr.txt`, quiet(scrub(r.stderr)).replaceAll(rp.ref, "<ref>"));
      }
      const cm = featureCoverage(diffs.migra!.sql);
      const cg = featureCoverage(diffs.pgdelta!.sql);
      out.push({
        id: "CL04c",
        title: "db diff --linked after the fixture is applied remotely: migra vs pg-delta",
        status: "info",
        detail: `fixture applied remotely: ${rs.ok ? "ok" : rs.error}; migra exit ${diffs.migra!.code}, pg-delta exit ${diffs.pgdelta!.code}`,
        measurements: {
          fixture_remote_ok: rs.ok ? 1 : 0,
          migra_exit: diffs.migra!.code,
          migra_ms_second_run: diffs.migra!.ms,
          migra_ms_first_run: diffs.migra!.firstMs,
          migra_error: diffs.migra!.err.replaceAll(rp.ref, "<ref>"),
          direct_host_A_records: Array.isArray(aRecs) ? aRecs.length : String(aRecs),
          direct_host_AAAA_records: Array.isArray(aaaaRecs) ? aaaaRecs.length : String(aaaaRecs),
          pgdelta_exit: diffs.pgdelta!.code,
          pgdelta_ms_second_run: diffs.pgdelta!.ms,
          pgdelta_ms_first_run: diffs.pgdelta!.firstMs,
          pgdelta_error: diffs.pgdelta!.err.replaceAll(rp.ref, "<ref>"),
          migra_stmt_starts: cm.stmt_starts,
          pgdelta_stmt_starts: cg.stmt_starts,
          migra_force_rls: cm.force_rls,
          pgdelta_force_rls: cg.force_rls,
          pgdelta_policies: cg.policies,
          pgdelta_comments: cg.comments,
          pgdelta_default_privs: cg.default_privs,
          pgdelta_drop_stmts: cg.drop_stmts,
          migra_drop_stmts: cm.drop_stmts,
        },
      });

      // ---------------- CL04d: pull, apply locally, fingerprint against remote ----------------
      // No --with-migration-history: the CLI runs that step by itself when supabase/migrations is empty.
      const pullOut = await sbx(["pull", "--project-ref", rp.ref, "--yes", "--output-format", "text"]);
      const summary = Object.fromEntries(
        pullOut.all
          .split("\n")
          .map((l) => l.match(/^\s{2}(config|migration_history|db|functions)\s+(unchanged|changed|failed|skipped|\S+)\s*(.*)$/))
          .filter((m): m is RegExpMatchArray => !!m)
          .map((m) => [m[1]!, `${m[2]}${m[3] ? ` ${m[3].trim().slice(0, 110)}` : ""}`]),
      );
      const migDir = join(L.dir, "supabase", "migrations");
      let migs: string[] = [];
      try {
        migs = readdirSync(migDir).filter((f) => f.endsWith(".sql"));
      } catch {
        // no migrations dir means pull wrote none
      }
      const files = listFiles(join(L.dir, "supabase")).filter((f) => !f.startsWith("config.toml") && !f.startsWith(".temp/"));
      saveRaw("cl04d-pull-output.txt", quiet(scrub(pullOut.all)).replaceAll(rp.ref, "<ref>"));
      const meas: Record<string, number | string> = {
        pull_exit: pullOut.code,
        pull_ms: pullOut.ms,
        summary_config: summary.config ?? "absent",
        summary_migration_history: summary.migration_history ?? "absent",
        summary_db: summary.db ?? "absent",
        summary_functions: summary.functions ?? "absent",
        migrations_written: migs.length,
        migration_bytes: migs.reduce((n, f) => n + readFileSync(join(migDir, f), "utf8").length, 0),
        files_written_outside_config: files.length,
        file_dirs: JSON.stringify(Object.entries(files.reduce((a: Record<string, number>, f) => ((a[f.split("/")[0]!] = (a[f.split("/")[0]!] ?? 0) + 1), a), {})).map(([k, v]) => `${k}:${v}`)),
      };
      const status: "info" = "info";
      let detail = `pull exit ${pullOut.code} in ${pullOut.ms} ms, ${migs.length} migration file(s); ${Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join("; ")}`;
      let evidence = tail(quiet(scrub(pullOut.all)).replaceAll(rp.ref, "<ref>"), 10);
      if (migs.length) {
        // The pulled schema migration alone: drop the history-table rows' effect by applying everything pulled.
        const start = await sbx(["db", "start"]);
        const reset = start.code === 0 ? await sbx(["db", "reset", "--local", "--yes", "--output-format", "text"]) : start;
        meas.local_reset_exit = reset.code;
        if (reset.code === 0) {
          const localFp = await fingerprint(L.dbUrl);
          const rr = await sql(rp.ctx, fingerprintSql());
          const remoteFp = rr.rows.map((r) => String((r as { l: string }).l));
          const d = diffFingerprints(remoteFp, localFp);
          saveRaw("cl04d-fp-only-remote.txt", d.onlyA.join("\n"));
          saveRaw("cl04d-fp-only-local.txt", d.onlyB.join("\n"));
          meas.remote_fingerprint_lines = remoteFp.length;
          meas.identical = d.same;
          meas.only_remote = d.onlyA.length;
          meas.only_local_after_pull_reset = d.onlyB.length;
          meas.only_remote_by_kind = JSON.stringify(countByKind(d.onlyA));
          meas.only_local_by_kind = JSON.stringify(countByKind(d.onlyB));
          detail += `; local reset from the pulled migration: ${d.same} fingerprint lines identical, ${d.onlyA.length} only on the remote, ${d.onlyB.length} only local`;
          evidence = [...d.onlyA.slice(0, 10).map((l) => `- ${l}`), ...d.onlyB.slice(0, 10).map((l) => `+ ${l}`)].join("\n");
        } else {
          detail += `; local reset exit ${reset.code}: ${tail(scrub(reset.all), 2).replace(/\n/g, " | ")}`;
          evidence = tail(scrub(reset.all), 12);
        }
      }
      out.push({ id: "CL04d", title: "supabase pull --yes, then the pulled migration applied locally and fingerprinted against the remote", status, detail, measurements: meas, evidence });
    } catch (e) {
      out.push({ id: "CL04", title: this.title, status: "fail", detail: `threw: ${(e instanceof Error ? e.message : String(e)).replace(/[a-z]{20}/g, "<ref>")}` });
    } finally {
      if (local) {
        await stopLocal(local);
        rmSync(dirname(local.home), { recursive: true, force: true });
      }
      deleted = await deleteProject(ctx, remote);
      if (remote) out.push({ id: "CL04-cleanup", title: "Throwaway project deleted", status: deleted ? "pass" : "fail", detail: deleted ? "DELETE answered 200/404" : "DELETE did not succeed; delete manually" });
    }
    return stamp(out, ver);
  },
};

export default mod;
