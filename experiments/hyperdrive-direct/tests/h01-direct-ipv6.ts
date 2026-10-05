/**
 * H01 - Hyperdrive against the IPv6-only direct connection, end to end.
 *
 * Provisions a throwaway Pro project WITHOUT the IPv4 add-on and measures:
 *
 *  a. the direct host's DNS shape: AAAA present, no A record (IPv6-only)
 *  b. `wrangler hyperdrive create` against db.<ref>.supabase.co:5432 -
 *     Cloudflare runs a live connect check before it saves, so a saved
 *     config is the first proof the origin is reachable over IPv6
 *  c. a Worker query through the binding returns a row, and
 *     inet_server_addr() reports an IPv6 address family (the family only is
 *     recorded, never the address)
 *  d. node-postgres NAMED prepared statements through Hyperdrive: the same
 *     named query executed twice on one client, then again from a fresh
 *     request (a second client that may land on another pooled connection)
 *
 * Cloudflare documents Hyperdrive's prepared-statement support and recommends
 * the direct string for Supabase; neither page says Hyperdrive reaches an
 * IPv6-only origin. This module is the runtime answer, dated.
 *
 * Wrangler auth: CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID
 * in the operator env (the Global API Key trio; a scoped token fails
 * wrangler's account lookup on this box). Self-skips without them.
 * Everything created here (project, worker, config) is deleted in finally.
 */
import { execFile } from "node:child_process";
import { resolve4, resolve6 } from "node:dns/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const run = promisify(execFile);
const REGION = "ap-southeast-1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wrangler(env: NodeJS.ProcessEnv, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await run("wrangler", args, { env, timeout: 180_000, cwd });
  return `${stdout}\n${stderr}`;
}

const WORKER = `
import { Client } from "pg";

export default {
  async fetch(req, env) {
    const mode = new URL(req.url).searchParams.get("mode") ?? "basic";
    const client = new Client({ connectionString: env.HD.connectionString });
    try {
      await client.connect();
      if (mode === "basic") {
        const r = await client.query(
          "select 1 as one, family(inet_server_addr())::int as fam, current_setting('server_version') as ver",
        );
        return Response.json({ row: r.rows[0] });
      }
      if (mode === "named") {
        const q = { name: "h01_named", text: "select $1::int + 1 as n" };
        const a = await client.query({ ...q, values: [41] });
        const b = await client.query({ ...q, values: [1] });
        return Response.json({ a: a.rows[0].n, b: b.rows[0].n });
      }
      return Response.json({ error: "unknown mode" });
    } catch (e) {
      return Response.json({ error: String(e && e.message ? e.message : e) });
    } finally {
      await client.end().catch(() => {});
    }
  },
};
`;

const mod: TestModule = {
  id: "H01",
  title: "Hyperdrive reaches the IPv6-only direct connection; named prepared statements work",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ORG = ctx.orgs.pro ?? "";
    const skip = (detail: string): TestResult[] => [{ id: "H01", title: this.title, status: "skip", detail }];
    if (!ORG) return skip("PVLAB_ORG_PRO not set");
    for (const v of ["CLOUDFLARE_EMAIL", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) {
      if (!process.env[v]) return skip(`${v} not set (wrangler Global API Key trio)`);
    }

    let ref = "";
    let configId = "";
    const workerName = `h01-probe-${Date.now().toString(36)}`;
    let workdir = "";
    const env = { ...process.env };
    const meas: Record<string, number | string> = {};
    const failures: string[] = [];

    try {
      const dbPass = `${crypto.randomUUID()}Aa1!`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `h01-hd-${Date.now()}`,
        db_pass: dbPass,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        return [{ id: "H01", title: this.title, status: "fail", detail: `create: HTTP ${create.status}` }];
      }

      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      // a. DNS shape of the direct host. Retry: the record can lag the status flip.
      const host = `db.${ref}.supabase.co`;
      let aaaa: string[] = [];
      for (let i = 0; i < 30 && aaaa.length === 0; i += 1) {
        aaaa = await resolve6(host).catch(() => []);
        if (aaaa.length === 0) await sleep(10_000);
      }
      const a = await resolve4(host).catch(() => [] as string[]);
      meas.direct_aaaa_records = aaaa.length;
      meas.direct_a_records = a.length;
      if (aaaa.length === 0) failures.push("direct host has no AAAA record");
      if (a.length !== 0) failures.push("direct host has an A record (not IPv6-only; IPv4 add-on present?)");

      // b. Hyperdrive create against the direct string (caching off: every
      // probe below must reach the origin, not a cached result).
      workdir = await mkdtemp(join(tmpdir(), "h01-"));
      const connStr = `postgresql://postgres:${encodeURIComponent(dbPass)}@${host}:5432/postgres`;
      let createErr = "";
      for (let i = 0; i < 6 && !configId; i += 1) {
        try {
          const out = await wrangler(env, ["hyperdrive", "create", `${workerName}-direct`, "--connection-string", connStr, "--caching-disabled"], workdir);
          configId = out.match(/[0-9a-f]{32}/)?.[0] ?? "";
          if (!configId) createErr = out.replace(/postgres(ql)?:\/\/[^\s]+/g, "<conn>").slice(0, 300);
        } catch (e) {
          createErr = String(e).replace(/postgres(ql)?:\/\/[^\s]+/g, "<conn>").slice(0, 300);
          await sleep(15_000);
        }
      }
      meas.hyperdrive_create = configId ? "saved" : "refused";
      if (!configId) {
        meas.hyperdrive_create_error = createErr;
        failures.push("hyperdrive create against the direct string did not save");
        throw new Error("no hyperdrive config");
      }

      await writeFile(join(workdir, "worker.js"), WORKER);
      await writeFile(join(workdir, "wrangler.jsonc"), JSON.stringify({
        name: workerName,
        main: "worker.js",
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        hyperdrive: [{ binding: "HD", id: configId }],
      }, null, 2));
      await run("bun", ["add", "pg@^8.16.3"], { cwd: workdir, timeout: 90_000 });
      const pgVer = await run("bun", ["pm", "ls"], { cwd: workdir }).then((r) => r.stdout.match(/pg@([\d.]+)/)?.[1] ?? "?").catch(() => "?");
      meas.pg_driver_version = pgVer;
      const deployOut = await wrangler(env, ["deploy", "--config", "wrangler.jsonc"], workdir);
      const base = deployOut.match(/https:\/\/[^\s/]+\.workers\.dev/)?.[0];
      if (!base) throw new Error(`no workers.dev URL in deploy output: ${deployOut.slice(0, 300)}`);

      const probe = async (mode: string): Promise<Record<string, unknown>> => {
        const res = await fetch(`${base}/?mode=${mode}`);
        return (await res.json()) as Record<string, unknown>;
      };

      // c. basic query; poll through deploy propagation.
      let basic: Record<string, unknown> = {};
      for (let i = 0; i < 24; i += 1) {
        try {
          basic = await probe("basic");
          if (basic.row) break;
        } catch (e) {
          basic = { error: String(e) };
        }
        await sleep(5_000);
      }
      const row = basic.row as { one?: number; fam?: number; ver?: string } | undefined;
      meas.query_through_hyperdrive = row?.one === 1 ? "ok" : `error: ${String(basic.error ?? "no row").slice(0, 200)}`;
      meas.server_addr_family = row?.fam === 6 ? "IPv6" : row?.fam === 4 ? "IPv4" : String(row?.fam ?? "?");
      meas.postgres_version = row?.ver ?? "?";
      if (row?.one !== 1) failures.push("query through Hyperdrive did not return a row");

      // d. named prepared statements, twice per client, two requests.
      const n1 = await probe("named");
      const n2 = await probe("named");
      const ok = (r: Record<string, unknown>) => r.a === 42 && r.b === 2;
      meas.named_prepared_first_request = ok(n1) ? "ok" : `error: ${String(n1.error ?? JSON.stringify(n1)).slice(0, 200)}`;
      meas.named_prepared_second_request = ok(n2) ? "ok" : `error: ${String(n2.error ?? JSON.stringify(n2)).slice(0, 200)}`;
      if (!ok(n1) || !ok(n2)) failures.push("named prepared statement through Hyperdrive failed");

      return [{
        id: "H01",
        title: this.title,
        status: failures.length === 0 ? "pass" : "fail",
        detail: failures.length === 0
          ? "IPv6-only direct host; hyperdrive create saved; query ok over IPv6; named prepared statements ok on two requests"
          : failures.join("; "),
        measurements: meas,
      }];
    } catch (e) {
      return [{
        id: "H01",
        title: this.title,
        status: "fail",
        detail: failures.length ? failures.join("; ") : `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements: meas,
      }];
    } finally {
      if (workdir) await wrangler(env, ["delete", "--name", workerName, "--force"], workdir).catch(() => "");
      if (configId) await wrangler(env, ["hyperdrive", "delete", configId], workdir || ".").catch(() => "");
      if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => null);
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
  },
};
export default mod;
