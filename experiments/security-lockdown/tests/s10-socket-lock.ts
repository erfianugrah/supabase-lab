/**
 * S10 - network restrictions actually lock the Postgres socket (closes the
 * half S02 leaves to privatelink-aws). S02 shows the HTTP tier is unaffected;
 * this shows the socket refuses. A real psql connection from this machine's IP
 * succeeds at baseline, then is refused once a restrictive CIDR that excludes
 * it is applied.
 *
 * Needs psql on PATH and the db password (ctx.dbPassword / PVLAB_DB_PASSWORD).
 * DESTRUCTIVE: mutates network restrictions; restores 0.0.0.0/0 in finally.
 */
import { spawnSync } from "node:child_process";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const RESTRICT = { dbAllowedCidrs: ["192.0.2.0/24"], dbAllowedCidrsV6: ["2001:db8::/32"] };
const OPEN = { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function psqlOk(connstr: string): { ok: boolean; err: string } {
  const r = spawnSync("psql", [connstr, "-tAc", "select 1"], {
    env: { ...process.env, PGCONNECT_TIMEOUT: "8" },
    timeout: 20_000,
    encoding: "utf8",
  });
  return { ok: r.status === 0, err: (r.stderr || r.error?.message || "").replace(/\s+/g, " ").slice(0, 160) };
}

const mod: TestModule = {
  id: "S10",
  title: "network restrictions lock the Postgres socket (psql refused from an excluded IP)",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const pw = ctx.dbPassword || process.env.PVLAB_DB_PASSWORD || "";
    if (!pw) return [{ id: "S10", title: this.title, status: "skip", detail: "no db password (ctx.dbPassword / PVLAB_DB_PASSWORD)" }];
    if (spawnSync("psql", ["--version"], { encoding: "utf8" }).status !== 0) {
      return [{ id: "S10", title: this.title, status: "skip", detail: "psql not on PATH" }];
    }
    const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
    const region = (proj.json as { region?: string })?.region || ctx.region;
    const connstr = `postgres://postgres.${ctx.ref}:${encodeURIComponent(pw)}@aws-0-${region}.pooler.supabase.com:5432/postgres?sslmode=require`;
    const results: TestResult[] = [];

    const base = psqlOk(connstr);
    results.push({
      id: "S10a",
      title: "baseline: psql connects through the pooler",
      status: base.ok ? "pass" : "skip",
      detail: base.ok ? "psql select 1 succeeded at 0.0.0.0/0" : `baseline connect failed (${base.err}) - no control, cannot prove the lock`,
    });
    if (!base.ok) return results;

    try {
      await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, RESTRICT);
      let refused = false;
      let lastErr = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 90_000 && !refused) {
        const r = psqlOk(connstr);
        if (!r.ok) { refused = true; lastErr = r.err; break; }
        await sleep(5000);
      }
      results.push({
        id: "S10b",
        title: "restricted: psql from the excluded IP is refused",
        status: refused ? "pass" : "fail",
        detail: refused
          ? `after applying 192.0.2.0/24 (excludes this machine), psql is refused in ${Math.round((Date.now() - t0) / 1000)}s: ${lastErr}. The socket locks; combined with S02 (HTTP unaffected), restrictions gate the DB only.`
          : `psql still connected 90s after the restriction - socket not locked as expected`,
        measurements: { refused: String(refused) },
      });
    } catch (e) {
      results.push({ id: "S10err", title: "S10 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await mgmt(ctx, "POST", `/projects/${ctx.ref}/network-restrictions/apply`, OPEN).catch(() => {});
    }
    return results;
  },
};
export default mod;
