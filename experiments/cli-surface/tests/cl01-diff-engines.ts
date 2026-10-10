/**
 * CL01 - `supabase db diff`: the migra engine against the pg-delta engine, on
 * one fixture, judged by the catalogs rather than by the SQL each prints.
 *
 * Sources for the claim under test, which disagree: changelog 44938 (pg-delta
 * alpha, `db diff --use-pg-delta`) says pg-delta is not yet the default; only
 * the Select 2026 blog says new `supabase init` projects default to it (writing
 * `[experimental.pgdelta] enabled = true`). Both are doc claims; this module is
 * the run, and CL01b records which engine actually ran.
 *
 *   CL01a  coverage: the same local database (app schema with RLS enabled and
 *          forced, six policies, grants incl. a column grant and sequence
 *          grants, default privileges, functions, a trigger, an extension,
 *          comments, a security_invoker view) diffed against an empty
 *          migrations baseline with `--use-migra` and `--use-pg-delta`. Per
 *          engine: which fixture features the emitted SQL mentions.
 *   CL01b  default: `db diff` with no engine flag on a freshly initialised
 *          project - which engine ran (the JSON `engine` field) and whether the
 *          output equals the explicit pg-delta output.
 *   CL01c  fidelity: each engine's diff saved as the only migration, applied to
 *          a reset database, and the catalogs fingerprinted
 *          (lib/fingerprint.ts) against the fixture database. Lines only on one
 *          side are what the round trip lost or invented.
 *   CL01d  wall time per engine, warm (a second run, shadow-baseline cache
 *          populated). Docker image pulls are excluded by pre-pulling through
 *          a first `db start`.
 *
 * Local vantage, Docker required (legacy backend). No remote project.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { cliVersion, dockerReachable, noCli, stamp, saveRaw, scrub, tail } from "../lib/cli";
import { diffFingerprints, countByKind, fingerprint } from "../lib/fingerprint";
import { diffSql, featureCoverage, startFixtureProject, teardown } from "../lib/fixture";

const mod: TestModule = {
  id: "CL01",
  title: "db diff: migra vs pg-delta on one fixture (coverage, default, fidelity, time)",
  where: "local",
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!(await dockerReachable())) return [{ id: "CL01", title: this.title, status: "skip", detail: "no Docker daemon reachable from this vantage" }];
    const ver = await cliVersion();
    if (ver === "absent") return [noCli("CL01", this.title)];
    const out: TestResult[] = [];
    let started: Awaited<ReturnType<typeof startFixtureProject>> | undefined;
    try {
      started = await startFixtureProject("cl01", 0);
      const { p } = started;
      ctx.log(`cl01: db started in ${started.startMs} ms, fixture applied in ${started.fixtureMs} ms`);
      const fpFixture = await fingerprint(p.dbUrl);

      // ---- CL01a / CL01d: run each engine twice, keep the second timing -------------
      const engines: Record<string, { flag: string[]; sql: string; engine: string; drops: string[]; warmMs: number; coldMs: number; code: number }> = {};
      for (const [name, flag] of [["migra", ["--use-migra"]], ["pgdelta", ["--use-pg-delta"]], ["default", []]] as const) {
        const first = await p.sb(["db", "diff", ...flag, "--output-format", "json"]);
        const second = await p.sb(["db", "diff", ...flag, "--output-format", "json"]);
        const d = diffSql(second);
        engines[name] = { flag: [...flag], sql: d.sql, engine: d.engine, drops: d.drops, warmMs: second.ms, coldMs: first.ms, code: second.code };
        saveRaw(`cl01-diff-${name}.sql`, d.sql);
        saveRaw(`cl01-diff-${name}.stderr.txt`, scrub(second.stderr));
      }
      const m = engines.migra!;
      const g = engines.pgdelta!;
      const def = engines.default!;
      const cm = featureCoverage(m.sql);
      const cg = featureCoverage(g.sql);

      out.push({
        id: "CL01a",
        title: "Fixture features present in each engine's diff",
        status: "info",
        detail: `migra ${cm.stmt_starts} statement starts, pg-delta ${cg.stmt_starts}; force_rls ${cm.force_rls}/${cg.force_rls}, comments ${cm.comments}/${cg.comments}, default_privs ${cm.default_privs}/${cg.default_privs}, security_invoker ${cm.security_invoker}/${cg.security_invoker}, column_grants ${cm.column_grants}/${cg.column_grants}`,
        measurements: Object.fromEntries([
          ...Object.entries(cm).map(([k, v]) => [`migra_${k}`, v]),
          ...Object.entries(cg).map(([k, v]) => [`pgdelta_${k}`, v]),
          ["migra_exit", m.code],
          ["pgdelta_exit", g.code],
          ["migra_drop_list", m.drops.join(" | ") || "none"],
          ["pgdelta_drop_list", g.drops.join(" | ") || "none"],
          ["fixture_policies", 6],
          ["fixture_force_rls_tables", 1],
          ["fixture_comments", 2],
          ["fixture_default_privilege_statements", 3],
        ]),
      });

      out.push({
        id: "CL01b",
        title: "Default engine on a fresh `supabase init` project",
        status: "info",
        detail: `no flag -> engine field "${def.engine}"; output identical to --use-pg-delta: ${def.sql === g.sql}`,
        measurements: {
          default_engine_field: def.engine || "absent",
          default_equals_pgdelta: def.sql === g.sql ? 1 : 0,
          default_equals_migra: def.sql === m.sql ? 1 : 0,
          init_config_pgdelta_enabled: /\[experimental\.pgdelta\]\s*\nenabled = true/.test(await Bun.file(join(p.dir, "supabase", "config.toml")).text()) ? 1 : 0,
        },
      });

      out.push({
        id: "CL01d",
        title: "db diff wall time per engine (second run, warm)",
        status: "info",
        detail: `migra ${m.warmMs} ms, pg-delta ${g.warmMs} ms, default ${def.warmMs} ms`,
        measurements: {
          migra_warm_ms: m.warmMs,
          migra_first_ms: m.coldMs,
          pgdelta_warm_ms: g.warmMs,
          pgdelta_first_ms: g.coldMs,
          default_warm_ms: def.warmMs,
          n_runs_per_engine: 2,
        },
      });

      // ---- CL01c: apply each diff as the only migration, compare catalogs ------------
      const migDir = join(p.dir, "supabase", "migrations");
      for (const [name, e] of [["migra", m], ["pgdelta", g]] as const) {
        rmSync(migDir, { recursive: true, force: true });
        mkdirSync(migDir, { recursive: true });
        writeFileSync(join(migDir, `20261010000000_${name}.sql`), e.sql);
        const reset = await p.sb(["db", "reset", "--local", "--yes", "--output-format", "text"]);
        const applied = reset.code === 0;
        saveRaw(`cl01-reset-${name}.txt`, scrub(reset.all));
        if (!applied) {
          out.push({
            id: `CL01c-${name}`,
            title: `Round trip through ${name}: apply the diff to a reset database`,
            status: "info",
            detail: `db reset exited ${reset.code}: ${tail(scrub(reset.all), 3).replace(/\n/g, " | ")}`,
            measurements: { engine: name, applied: 0, reset_exit: reset.code },
            evidence: tail(scrub(reset.all), 12),
          });
          continue;
        }
        const fp = await fingerprint(p.dbUrl);
        const d = diffFingerprints(fpFixture, fp);
        saveRaw(`cl01-fp-only-fixture-${name}.txt`, d.onlyA.join("\n"));
        saveRaw(`cl01-fp-only-roundtrip-${name}.txt`, d.onlyB.join("\n"));
        const lostKinds = countByKind(d.onlyA);
        const addedKinds = countByKind(d.onlyB);
        out.push({
          id: `CL01c-${name}`,
          title: `Round trip through ${name}: catalog fingerprint after applying the diff`,
          status: d.onlyA.length === 0 && d.onlyB.length === 0 ? "pass" : "info",
          detail: `${d.same} fingerprint lines identical, ${d.onlyA.length} only in the fixture database, ${d.onlyB.length} only after the round trip`,
          measurements: {
            engine: name,
            applied: 1,
            fingerprint_lines_fixture: fpFixture.length,
            identical: d.same,
            missing_after_roundtrip: d.onlyA.length,
            extra_after_roundtrip: d.onlyB.length,
            missing_by_kind: JSON.stringify(lostKinds),
            extra_by_kind: JSON.stringify(addedKinds),
          },
          evidence: [...d.onlyA.slice(0, 12).map((l) => `- ${l}`), ...d.onlyB.slice(0, 6).map((l) => `+ ${l}`)].join("\n"),
        });
      }
    } catch (e) {
      out.push({ id: "CL01", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await teardown(started?.p);
    }
    return stamp(out, ver);
  },
};

export default mod;
