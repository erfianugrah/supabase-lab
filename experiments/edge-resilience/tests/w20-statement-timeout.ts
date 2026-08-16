/**
 * W20 - statement timeout and lock-wait signature.
 *
 * Measures how Postgres handles statement_timeout and lock_timeout
 * when specific parameters are set via SET LOCAL.
 *
 * Pass criteria: both verbatim errors + wall times recorded.
 * Any measured behavior passes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { spawn } from "node:child_process";

const mod: TestModule = {
  id: "W20",
  title: "statement timeout and lock-wait signature",
  where: "local",
  requires: ["pat"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const measurements: Record<string, string | number> = {};
    const poolerHost = ctx.endpoints["pooler"];
    const dbUser = `postgres.${ctx.ref}`;
    const dbPassword = ctx.dbPassword;

    if (!poolerHost) {
      return {
        id: "W20",
        title: this.title,
        status: "skip",
        detail: "missing pooler endpoint",
      };
    }

    let sessionAProcess: any = null;

    try {
      // 1. Setup: Create the table.
      ctx.log("Creating table public.w20_t...");
      const createRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: "CREATE TABLE IF NOT EXISTS public.w20_t(id int primary key)",
      });
      if (createRes.status >= 300) {
        throw new Error(`Table creation failed: HTTP ${createRes.status}: ${createRes.text.slice(0, 200)}`);
      }

      // 2. Timeout signature: set local statement_timeout = '2s'; select pg_sleep(5);
      ctx.log("Testing statement_timeout...");
      const timeoutStart = Date.now();
      const timeoutRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: "BEGIN; SET LOCAL statement_timeout = '2s'; SELECT pg_sleep(5); COMMIT;",
      });
      const timeoutEnd = Date.now();
      measurements["timeout_status"] = timeoutRes.status;
      measurements["timeout_duration_ms"] = timeoutEnd - timeoutStart;
      measurements["timeout_error_verbatim"] = timeoutRes.text.slice(0, 200);

      // 3. Lock-wait: Session A holds advisory lock; Session B waits with lock_timeout.
      ctx.log("Testing lock_timeout...");
      
      // We'll use a child process to run Session A in the background.
      sessionAProcess = spawn("psql", [
        "-h", poolerHost,
        "-p", "5432",
        "-U", dbUser,
        "-d", "postgres",
        "-c", "SELECT pg_advisory_lock(42); SELECT pg_sleep(10);",
      ], {
        env: { ...process.env, PGPASSWORD: dbPassword },
      });

      // Small delay to ensure Session A actually acquires the lock.
      await new Promise(r => setTimeout(r, 2000));

      const lockStart = Date.now();
      const lockRes = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: "BEGIN; SET LOCAL lock_timeout = '3s'; SELECT pg_advisory_lock(42); COMMIT;",
      });
      const lockEnd = Date.now();
      
      measurements["lock_status"] = lockRes.status;
      measurements["lock_duration_ms"] = lockEnd - lockStart;
      measurements["lock_error_verbatim"] = lockRes.text.slice(0, 200);

      const pass = 
        timeoutRes.text.includes("57014") && 
        lockRes.text.includes("55P03");

      return {
        id: "W20",
        title: this.title,
        status: pass ? "pass" : "fail",
        detail: pass 
          ? "Both timeout and lock_timeout signatures verified" 
          : `Timeout error: ${timeoutRes.text.slice(0, 50)}, Lock error: ${lockRes.text.slice(0, 50)}`,
        measurements,
      };

    } catch (e: any) {
      return {
        id: "W20",
        title: "W20 error",
        status: "fail",
        detail: e.message,
        measurements,
      };
    } finally {
      // 4. Cleanup: Drop the table.
      ctx.log("Cleaning up public.w20_t...");
      await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, {
        query: "DROP TABLE IF EXISTS public.w20_t",
      }).catch(() => {});
      
      if (sessionAProcess && sessionAProcess.kill) {
        sessionAProcess.kill();
      }
    }
  },
};

export default mod;
