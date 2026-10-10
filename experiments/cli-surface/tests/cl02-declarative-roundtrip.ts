/**
 * CL02 - declarative schemas with the bundled pg-delta: export, sync, reset,
 * compare.
 *
 * Claim under test (changelog 44938, `db schema declarative`): the declarative
 * tree under `supabase/schemas/` is the source of truth, `sync` turns the
 * difference between it and `supabase/migrations/` into a migration, and a
 * database built from those migrations equals the one the tree was exported
 * from.
 *
 *   CL02a  `db schema declarative generate --local` on the fixture database:
 *          what the tree looks like (file count, layout, load order length,
 *          whether platform extensions that already existed are exported) and
 *          how long it took.
 *   CL02b  `sync --no-apply` against an EMPTY migrations directory: one
 *          migration, its size, and whether it equals the plain
 *          `db diff --use-pg-delta` output on the same database.
 *   CL02c  fidelity: `db reset` applies that migration; the catalogs are
 *          fingerprinted (lib/fingerprint.ts) against the fixture database.
 *   CL02d  idempotence: `sync` again, `db diff` again, and a second `generate`
 *          into a scratch directory compared file by file with the first.
 *
 * Local vantage, Docker required (legacy backend, pg-delta engine).
 */
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { cliVersion, dockerReachable, noCli, stamp, saveRaw, scrub, tail } from "../lib/cli";
import { diffFingerprints, countByKind, fingerprint } from "../lib/fingerprint";
import { diffSql, listFiles, norm, startFixtureProject, statementStarts, teardown } from "../lib/fixture";

const mod: TestModule = {
  id: "CL02",
  title: "Declarative schemas (pg-delta): generate, sync, reset, fingerprint, idempotence",
  where: "local",
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await dockerReachable())) return [{ id: "CL02", title: this.title, status: "skip", detail: "no Docker daemon reachable from this vantage" }];
    const ver = await cliVersion();
    if (ver === "absent") return [noCli("CL02", this.title)];
    const out: TestResult[] = [];
    let started: Awaited<ReturnType<typeof startFixtureProject>> | undefined;
    try {
      started = await startFixtureProject("cl02", 1);
      const { p } = started;
      const fpFixture = await fingerprint(p.dbUrl);
      const schemasDir = join(p.dir, "supabase", "schemas");
      const migDir = join(p.dir, "supabase", "migrations");

      // ---- CL02a: generate ------------------------------------------------------
      const gen = await p.sb(["db", "schema", "declarative", "generate", "--local", "--output-format", "text"]);
      const files = listFiles(schemasDir);
      const exportMeta = JSON.parse(readFileSync(join(schemasDir, ".pgdelta-export.json"), "utf8")) as { loadOrder?: string[]; profile?: string; redactSecrets?: boolean; formatVersion?: number };
      const bytes = files.reduce((n, f) => n + statSync(join(schemasDir, f)).size, 0);
      const byDir: Record<string, number> = {};
      for (const f of files) {
        const top = f.split("/").slice(0, f.startsWith("_cluster") ? 2 : 2).join("/");
        byDir[top] = (byDir[top] ?? 0) + 1;
      }
      saveRaw("cl02-tree-files.txt", files.join("\n"));
      out.push({
        id: "CL02a",
        title: "declarative generate --local on the fixture database",
        status: gen.code === 0 ? "info" : "fail",
        detail: `exit ${gen.code}, ${files.length} files (${bytes} bytes) in ${gen.ms} ms; load order ${exportMeta.loadOrder?.length ?? 0} entries; profile ${exportMeta.profile}`,
        measurements: {
          exit: gen.code,
          generate_ms: gen.ms,
          files: files.length,
          bytes,
          load_order_entries: exportMeta.loadOrder?.length ?? 0,
          export_profile: exportMeta.profile ?? "",
          export_format_version: exportMeta.formatVersion ?? -1,
          export_redact_secrets: exportMeta.redactSecrets === undefined ? "absent" : String(exportMeta.redactSecrets),
          platform_extension_files: files.filter((f) => f.startsWith("_cluster/extensions/")).map((f) => f.split("/").pop()).join(","),
          files_by_dir: JSON.stringify(byDir),
          default_privilege_files: files.filter((f) => f.endsWith("default_privileges.sql")).join(","),
        },
        evidence: tail(scrub(gen.all), 6),
      });
      if (gen.code !== 0) return stamp(out, ver);

      // plain diff SQL for comparison with the sync migration
      const plain = diffSql(await p.sb(["db", "diff", "--use-pg-delta", "--output-format", "json"]));

      // ---- CL02b: sync --no-apply against empty migrations -----------------------
      const sync = await p.sb(["db", "schema", "declarative", "sync", "--no-apply", "--name", "roundtrip", "--output-format", "text"]);
      const migs = readdirSync(migDir).filter((f) => f.endsWith(".sql"));
      const mig = migs[0] ? readFileSync(join(migDir, migs[0]), "utf8") : "";
      saveRaw("cl02-sync-migration.sql", mig);
      const planSet = new Set(plain.sql.split(/;\s*\n/).map(norm).filter(Boolean));
      const migSet = new Set(mig.split(/;\s*\n/).map(norm).filter(Boolean));
      const onlyMig = [...migSet].filter((s) => !planSet.has(s));
      const onlyPlain = [...planSet].filter((s) => !migSet.has(s));
      out.push({
        id: "CL02b",
        title: "declarative sync --no-apply against an empty migrations directory",
        status: sync.code === 0 && migs.length === 1 ? "info" : "fail",
        detail: `exit ${sync.code}, ${migs.length} migration file(s), ${mig.length} bytes, ${statementStarts(mig)} statement starts in ${sync.ms} ms; ${onlyMig.length} statements only in the migration, ${onlyPlain.length} only in db diff --use-pg-delta`,
        measurements: {
          exit: sync.code,
          sync_ms: sync.ms,
          migration_files: migs.length,
          migration_bytes: mig.length,
          migration_statement_starts: statementStarts(mig),
          diff_statement_starts: statementStarts(plain.sql),
          statements_only_in_migration: onlyMig.length,
          statements_only_in_db_diff: onlyPlain.length,
          identical_to_db_diff: norm(mig) === norm(plain.sql) ? 1 : 0,
        },
        evidence: [...onlyMig.slice(0, 5).map((s) => `migration only: ${s.slice(0, 140)}`), ...onlyPlain.slice(0, 5).map((s) => `db diff only: ${s.slice(0, 140)}`)].join("\n"),
      });
      if (migs.length !== 1) return stamp(out, ver);

      // ---- CL02c: reset + fingerprint ---------------------------------------------
      const reset = await p.sb(["db", "reset", "--local", "--yes", "--output-format", "text"]);
      if (reset.code !== 0) {
        out.push({ id: "CL02c", title: "db reset applies the sync migration", status: "fail", detail: `exit ${reset.code}: ${tail(scrub(reset.all), 4).replace(/\n/g, " | ")}`, evidence: tail(scrub(reset.all), 15) });
        return stamp(out, ver);
      }
      const fp = await fingerprint(p.dbUrl);
      const d = diffFingerprints(fpFixture, fp);
      saveRaw("cl02-fp-only-fixture.txt", d.onlyA.join("\n"));
      saveRaw("cl02-fp-only-roundtrip.txt", d.onlyB.join("\n"));
      out.push({
        id: "CL02c",
        title: "Fingerprint after reset (migration from the exported tree) vs the fixture database",
        status: d.onlyA.length === 0 && d.onlyB.length === 0 ? "pass" : "info",
        detail: `${d.same} fingerprint lines identical, ${d.onlyA.length} only in the fixture database, ${d.onlyB.length} only after the round trip; reset ${reset.ms} ms`,
        measurements: {
          fingerprint_lines_fixture: fpFixture.length,
          identical: d.same,
          missing_after_roundtrip: d.onlyA.length,
          extra_after_roundtrip: d.onlyB.length,
          missing_by_kind: JSON.stringify(countByKind(d.onlyA)),
          extra_by_kind: JSON.stringify(countByKind(d.onlyB)),
          reset_ms: reset.ms,
        },
        evidence: [...d.onlyA.slice(0, 10).map((l) => `- ${l}`), ...d.onlyB.slice(0, 10).map((l) => `+ ${l}`)].join("\n"),
      });

      // ---- CL02d: idempotence -------------------------------------------------------
      const again = await p.sb(["db", "schema", "declarative", "sync", "--no-apply", "--name", "again", "--output-format", "text"]);
      const migsAfter = readdirSync(migDir).filter((f) => f.endsWith(".sql")).length;
      const diff2 = await p.sb(["db", "diff", "--output-format", "json"]);
      const diff2sql = diffSql(diff2).sql;
      const scratch = join(p.dir, "export2");
      mkdirSync(scratch, { recursive: true });
      const gen2 = await p.sb(["db", "schema", "declarative", "generate", "--local", "--output-dir", scratch, "--output-format", "text"]);
      const files2 = listFiles(scratch);
      const changed = files2.filter((f) => !files.includes(f) || readFileSync(join(scratch, f), "utf8") !== readFileSync(join(schemasDir, f), "utf8"));
      const missing = files.filter((f) => !files2.includes(f));
      out.push({
        id: "CL02d",
        title: "Idempotence: second sync, db diff, and a second export",
        status: migsAfter === 1 && diff2sql.trim() === "" && changed.length === 0 && missing.length === 0 ? "pass" : "info",
        detail: `second sync wrote ${migsAfter - 1} new migration(s); db diff after reset ${diff2sql.trim() === "" ? "empty" : `${diff2sql.length} bytes`}; second export ${changed.length} changed, ${missing.length} missing files`,
        measurements: {
          second_sync_exit: again.code,
          second_sync_new_migrations: migsAfter - 1,
          second_sync_says_no_changes: /no schema changes/i.test(again.all) ? 1 : 0,
          diff_after_reset_bytes: diff2sql.length,
          second_export_exit: gen2.code,
          second_export_files: files2.length,
          second_export_changed_files: changed.length,
          second_export_missing_files: missing.length,
        },
        evidence: tail(scrub(again.all), 4) + (changed.length ? `\nchanged: ${changed.slice(0, 5).join(", ")}` : ""),
      });
    } catch (e) {
      out.push({ id: "CL02", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await teardown(started?.p);
    }
    return stamp(out, ver);
  },
};

export default mod;
