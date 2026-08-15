/**
 * W06 - cold DR timing (pg_dump + restore).
 *
 * Measures the RTO for a database dump and restore operation.
 * Destructive: creates and drops tables.
 */
import type { TestModule, Ctx, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { execSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import path from "path";

const mod: TestModule = {
  id: "W06",
  title: "cold DR timing (pg_dump + restore)",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const measurements: Record<string, number | string> = {};
    let dumpMs: number = 0;
    let restoreMs: number = 0;
    let bytes: number = 0;
    let rows: number = 0;
    const dumpFile = path.join("/tmp", `w06-dump-${ctx.ref}-${Date.now()}.sql`);
    const poolerHost = "aws-0-ap-southeast-2.pooler.supabase.com";
    const dbUser = `postgres.${ctx.ref}`;

    try {
      // Step 1: Seed table w_dr with 10k rows via query endpoint.
      const seedQuery = `
        CREATE TABLE IF NOT EXISTS public.w_dr (
          id serial PRIMARY KEY,
          data text NOT NULL,
          created_at timestamptz DEFAULT now()
        );
        INSERT INTO public.w_dr (data)
        SELECT md5(lpad(i::text, 100, '0'))
        FROM generate_series(1, 10000) AS i;
      `;

      const seedRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: seedQuery,
      });

      if (seedRes.status >= 300) {
        return {
          id: "W06",
          title: this.title,
          status: "fail",
          detail: `Seeding failed: HTTP ${seedRes.status}`,
          evidence: seedRes.text.slice(0, 400),
          measurements,
        };
      }

      // Step 2: pg_dump the table.
      const dumpStart = Date.now();
      try {
        execSync(
          `PGPASSWORD="${ctx.dbPassword}" pg_dump --host=${poolerHost} --port=5432 --username="${dbUser}" --dbname=postgres --table=public.w_dr --file="${dumpFile}"`,
          { env: { ...process.env, PGPASSWORD: ctx.dbPassword }, stdio: "ignore" }
        );
      } catch (e: any) {
        return {
          id: "W06",
          title: this.title,
          status: "fail",
          detail: `pg_dump failed: ${e.message}`,
          measurements,
        };
      }
      dumpMs = Date.now() - dumpStart;
      const stats = await import("fs").then((f) => f.statSync(dumpFile));
      bytes = stats.size;

      // Step 3: Drop the table.
      const dropRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: "DROP TABLE IF EXISTS public.w_dr;",
      });
      if (dropRes.status >= 300) {
        return {
          id: "W06",
          title: this.title,
          status: "fail",
          detail: `DROP TABLE failed: HTTP ${dropRes.status}`,
          evidence: dropRes.text.slice(0, 400),
          measurements,
        };
      }

      // Step 4: Restore (psql -f).
      const restoreStart = Date.now();
      try {
        execSync(
          `PGPASSWORD="${ctx.dbPassword}" psql --host=${poolerHost} --port=5432 --username="${dbUser}" --dbname=postgres -f "${dumpFile}"`,
          { env: { ...process.env, PGPASSWORD: ctx.dbPassword }, stdio: "ignore" }
        );
      } catch (e: any) {
        return {
          id: "W06",
          title: this.title,
          status: "fail",
          detail: `psql restore failed: ${e.message}`,
          measurements,
        };
      }
      restoreMs = Date.now() - restoreStart;

      // Step 5: Verify row count.
      const verifyRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: "SELECT count(*) FROM public.w_dr;",
      });
      if (verifyRes.json) {
        const rowsArr = verifyRes.json as any[];
        rows = parseInt(rowsArr[0]?.count ?? "0", 10);
      }

      if (rows !== 10000) {
        return {
          id: "W06",
          title: this.title,
          status: "fail",
          detail: `Row count mismatch: expected 10000, got ${rows}`,
          measurements: { ...measurements, rows },
        };
      }

      measurements["dump_ms"] = dumpMs;
      measurements["restore_ms"] = restoreMs;
      measurements["rows"] = rows;
      measurements["bytes"]	= bytes;

      return {
        id: "W06",
        title: this.title,
        status: "pass",
        detail: "Cold DR dump/restore completed successfully",
        measurements,
      };
    } catch (e: unknown) {
      return {
        id: "W06",
        title: this.title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements,
      };
    } finally {
      // Cleanup.
      try {
        await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
          query: "DROP TABLE IF EXISTS public.w_dr;",
        }).catch(() => {});
        if (existsSync(dumpFile)) {
          unlinkSync(dumpFile);
        }
      } catch (e) {
        ctx.log(`WARN: cleanup failed for W06: ${e}`);
      }
    }
  },
};

export default mod;
