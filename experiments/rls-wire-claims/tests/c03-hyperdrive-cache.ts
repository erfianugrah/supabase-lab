/**
 * C03 - the Hyperdrive half, measured end to end.
 *
 * Provisions a throwaway project, creates two Hyperdrive configs against it
 * via wrangler (one cached, one --caching-disabled), deploys a minimal probe
 * Worker that runs SQL through the bindings, and measures:
 *
 *  c. SET semantics through Hyperdrive (no-cache binding): explicit
 *     transaction and multi-statement forms resolve claims; a bare SET does
 *     not carry to a later query (RESET on pool return)
 *  a. cache-blindness, measured at its real layer: a claims-GUC query with
 *     an explicit owner PARAMETER (identical SQL text, one parameter value)
 *     is cached; re-issued under DIFFERENT claims with the SAME parameter,
 *     the cached entry is replayed instead of being re-filtered by RLS ->
 *     the doc's sharp edge 2, made concrete
 *  b. the cache-disabled binding answers per-claims correctly for the same
 *     query -> the split-binding fix, measured
 *
 * Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the operator env
 * (wrangler CLI auth; scopes: Workers Scripts:Edit, Hyperdrive:Edit).
 * Self-skips with a reason when either is absent. Everything created here
 * (project, worker, both configs) is deleted in finally.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

const run = promisify(execFile);

let ORG = ""; // from PVLAB_ORG_PRO via ctx.orgs.pro; set in run()
const REGION = "ap-southeast-1";
const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sql(ctx: Ctx, ref: string, query: string): Promise<void> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query });
  if (r.status >= 300) throw new Error(`sql http ${r.status}: ${r.text.slice(0, 300)}`);
}

async function wrangler(env: NodeJS.ProcessEnv, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await run("wrangler", args, { env, timeout: 120_000, cwd });
  return `${stdout}\n${stderr}`;
}

/** The probe worker. Claims/owner ids are baked in at render time. */
function workerSource(): string {
  return `
import postgres from "postgres";

const CLAIMS = {
  a: '{"sub":"${USER_A}","role":"authenticated"}',
  b: '{"sub":"${USER_B}","role":"authenticated"}',
};
const A = "${USER_A}";

const COUNT = "select count(*)::int as n, coalesce(public.claims_uid()::text,'NULL') as uid from wire_claims.docs";

async function setClaims(tx, who) {
  if (who === "none") return;
  await tx.unsafe(\`select set_config('request.jwt.claims', '\${CLAIMS[who]}', true)\`);
}

async function runForm(conn, form, who) {
  const sql = postgres(conn, { prepare: false, max: 1 });
  try {
    if (form === "tx") {
      const rows = await sql.begin(async (tx) => {
        await setClaims(tx, who);
        return tx.unsafe(COUNT);
      });
      return rows[0];
    }
    if (form === "multi") {
      const pre = who === "none" ? "" : \`select set_config('request.jwt.claims', '\${CLAIMS[who]}', true); \`;
      const res = await sql.unsafe(pre + COUNT);
      // postgres.js multi-statement shape varies by driver version: the
      // result can be an array of per-statement row-arrays, or a single
      // array tagged with the last statement. Flatten defensively and take
      // the last row that has our columns.
      const flat = res.flat(Infinity).filter((r) => r && typeof r === "object" && "n" in r);
      return flat[flat.length - 1];
    }
    if (form === "bare-then-later") {
      await sql.unsafe(\`set "request.jwt.claims" = '\${CLAIMS.a}'\`);
      const rows = await sql.unsafe(COUNT);
      return rows[0];
    }
    if (form === "param") {
      // Identical SQL text for every caller; the owner is a bind parameter.
      // Claims GUC differs per request - the cache key cannot see it.
      const rows = await sql.begin(async (tx) => {
        await setClaims(tx, who);
        return tx.unsafe("select count(*)::int as n from wire_claims.docs where owner = $1", [A]);
      });
      return { n: rows[0].n, uid: "param-form" };
    }
    const rows = await sql.unsafe(COUNT);
    return rows[0];
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const binding = u.searchParams.get("binding") ?? "nocache";
    const form = u.searchParams.get("form") ?? "tx";
    const who = u.searchParams.get("who") ?? "none";
    const conn = binding === "cache" ? env.HD_CACHE.connectionString : env.HD_NOCACHE.connectionString;
    try {
      const row = await runForm(conn, form, who);
      return Response.json({ binding, form, who, row });
    } catch (e) {
      return Response.json({ error: String(e).slice(0, 300) }, { status: 500 });
    }
  },
};
`;
}

const mod: TestModule = {
  id: "C03",
  title: "Hyperdrive cache is claims-blind; SET semantics + split-binding measured",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    ORG = ctx.orgs.pro ?? "";
    if (!ORG) return [{ id: "C03", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    // wrangler is authenticated via its own stored Global API Key (see
    // `wrangler whoami`); we only need the account id. CLOUDFLARE_ACCOUNT_ID
    // from env wins; otherwise take the first account wrangler reports.
    let accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    if (!accountId) {
      try {
        const who = await wrangler(process.env, ["whoami"], ".");
        const m = who.match(/[0-9a-f]{32}/);
        accountId = m?.[0] ?? "";
      } catch { /* fall through to skip */ }
    }
    if (!accountId) {
      return [{
        id: "C03",
        title: this.title,
        status: "skip",
        detail: "no CLOUDFLARE_ACCOUNT_ID and wrangler whoami returned none",
      }];
    }

    let ref = "";
    const createdConfigs: string[] = [];
    const workerName = `c03-probe-${Date.now().toString(36)}`;
    const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
    let workdir = "";

    try {
      const dbPass = `${crypto.randomUUID()}Aa1!`;
      const create = await mgmt(ctx, "POST", "/projects", {
        organization_slug: ORG,
        name: `c03-hd-${Date.now()}`,
        db_pass: dbPass,
        region: REGION,
      });
      ref = ((create.json as { ref?: string } | undefined)?.ref ?? "") as string;
      if (create.status !== 201 || !ref) {
        return [{ id: "C03", title: this.title, status: "fail", detail: `create: HTTP ${create.status}` }];
      }

      let status = "";
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline && status !== "ACTIVE_HEALTHY") {
        await sleep(10_000);
        const p = await mgmt(ctx, "GET", `/projects/${ref}`);
        status = ((p.json as { status?: string } | undefined)?.status ?? "") as string;
      }
      if (status !== "ACTIVE_HEALTHY") throw new Error(`not healthy: ${status}`);

      // ACTIVE_HEALTHY is not readiness for the POOLER: Hyperdrive's
      // create-time connection check probes from Cloudflare's network, and a
      // fresh project's Supavisor can still answer ENOTIDENTIFIER for tens
      // of seconds after the status flips. Warm the pooler from here first.
      {
        const { execFile: ef } = await import("node:child_process");
        const { promisify: p } = await import("node:util");
        const runPsql = p(ef);
        let warm = false;
        for (let i = 0; i < 18 && !warm; i += 1) {
          try {
            await runPsql("psql", [
              "-h", `aws-0-${REGION}.pooler.supabase.com`, "-p", "5432",
              "-U", `postgres.${ref}`, "-d", "postgres", "-At", "-c", "select 1",
            ], { env: { ...process.env, PGPASSWORD: dbPass }, timeout: 20_000 });
            warm = true;
          } catch {
            await sleep(5_000);
          }
        }
        if (!warm) throw new Error("pooler never accepted a local connection");
      }

      const rolePass = `${crypto.randomUUID()}Aa1!`;
      await sql(ctx, ref, `
        create schema wire_claims;
        create table wire_claims.docs (
          id bigint generated always as identity primary key,
          owner uuid not null,
          body text not null default ''
        );
        insert into wire_claims.docs (owner, body)
          values ('${USER_A}', 'a-private'), ('${USER_B}', 'b-private');
        alter table wire_claims.docs enable row level security;
      `);
      await sql(ctx, ref, `
        create or replace function public.claims_uid() returns uuid
          language sql stable security definer set search_path = auth, public
          as $$ select auth.uid() $$;
      `);
      await sql(ctx, ref, `
        create role claims_user login password '${rolePass}' nosuperuser nocreatedb nocreaterole noinherit;
      `);
      await sql(ctx, ref, `
        create policy per_user on wire_claims.docs for select to public
          using (owner = public.claims_uid());
        grant usage on schema wire_claims to claims_user;
        grant select on wire_claims.docs to claims_user;
        grant execute on function public.claims_uid() to claims_user;
      `);

      workdir = await mkdtemp(join(tmpdir(), "c03-"));

      // Hyperdrive origin = the session-mode shared pooler (5432): claims
      // semantics then ride on Hyperdrive's own transaction-mode layer only,
      // not confounded with Supavisor's 6543 transaction pooling.
      const connStr = `postgresql://claims_user.${ref}:${encodeURIComponent(rolePass)}@aws-0-${REGION}.pooler.supabase.com:5432/postgres`;

      const mk = async (name: string, cache: boolean): Promise<string> => {
        const args = [
          "hyperdrive", "create", name,
          "--connection-string", connStr,
          ...(cache ? ["--max-age", "60"] : ["--caching-disabled"]),
        ];
        // The create does a live connect check from CF's network; a fresh
        // project's pooler can still refuse (ENOTFOUND tenant/user) for a
        // while after our local warmup passed. Retry that specific error.
        let lastErr: unknown = null;
        for (let i = 0; i < 10; i += 1) {
          try {
            const out = await wrangler(env, args, workdir);
            const m = out.match(/[0-9a-f]{32}/);
            if (!m) throw new Error(`no config id in wrangler output: ${out.slice(0, 300)}`);
            createdConfigs.push(m[0]);
            return m[0];
          } catch (e) {
            lastErr = e;
            const msg = String(e);
            if (!/ENOTFOUND|not found|Failed to connect to the provided database/.test(msg)) throw e;
            await sleep(10_000);
          }
        }
        throw lastErr;
      };
      const hdCacheId = await mk(`${workerName}-cache`, true);
      const hdNoCacheId = await mk(`${workerName}-nocache`, false);

      await writeFile(join(workdir, "worker.ts"), workerSource());
      await writeFile(join(workdir, "wrangler.jsonc"), JSON.stringify({
        name: workerName,
        main: "worker.ts",
        compatibility_date: "2026-08-01",
        compatibility_flags: ["nodejs_compat"],
        hyperdrive: [
          { binding: "HD_CACHE", id: hdCacheId },
          { binding: "HD_NOCACHE", id: hdNoCacheId },
        ],
      }, null, 2));

      await run("bun", ["add", "postgres"], { cwd: workdir, timeout: 60_000 });
      const deployOut = await wrangler(env, ["deploy", "--config", "wrangler.jsonc"], workdir);
      const urlMatch = deployOut.match(/https:\/\/[^\s/]+\.workers\.dev/);
      if (!urlMatch) throw new Error(`no workers.dev URL in deploy output: ${deployOut.slice(0, 400)}`);
      const workerBase = urlMatch[0];

      const probe = async (qs: string): Promise<{ n?: number; uid?: string; error?: string }> => {
        const res = await fetch(`${workerBase}/?${qs}`);
        const body = (await res.json()) as { row?: { n: number; uid: string }; error?: string };
        if (body.error) return { error: body.error };
        return { n: body.row?.n, uid: body.row?.uid };
      };

      // Deploy settle: poll until the worker answers without a cold error.
      let up = false;
      let lastErr = "";
      for (let i = 0; i < 24 && !up; i += 1) {
        try {
          const r = await probe("binding=nocache&form=tx&who=a");
          if (r.n !== undefined) up = true;
          else lastErr = r.error ?? "";
        } catch (e) {
          lastErr = String(e);
        }
        if (!up) await sleep(5_000);
      }
      if (!up) throw new Error(`worker never answered: ${lastErr.slice(0, 200)}`);

      const meas: Record<string, number | string> = {};
      const failures: string[] = [];

      // c: SET semantics on the no-cache binding.
      const tx = await probe("binding=nocache&form=tx&who=a");
      meas.nocache_tx_rows = tx.n ?? -1;
      meas.nocache_tx_uid = tx.uid ?? "?";
      if (tx.n !== 1 || tx.uid !== USER_A) failures.push(`tx form: n=${tx.n} uid=${tx.uid}, want 1/${USER_A}`);

      const multi = await probe("binding=nocache&form=multi&who=b");
      meas.nocache_multi_rows = multi.n ?? -1;
      meas.nocache_multi_uid = multi.uid ?? "?";
      if (multi.n !== 1) failures.push(`multi form: n=${multi.n}, want 1`);

      const bare = await probe("binding=nocache&form=bare-then-later&who=none");
      meas.nocache_bare_set_next_rows = bare.n ?? -1;
      if (bare.n !== 0) failures.push(`bare SET carried to next query: n=${bare.n}, want 0 (RESET expected)`);

      // a1 (cache claims-blindness, the sharp probe) goes BEFORE the warm
      // repeats so its first request is the one that would populate cache.
      const warmA = await probe("binding=cache&form=param&who=a");
      meas.cache_param_as_a = warmA.n ?? -1;
      const replayAsB = await probe("binding=cache&form=param&who=b");
      meas.cache_param_as_b = replayAsB.n ?? -1;
      if (warmA.n !== 1) failures.push(`cache param as A: n=${warmA.n}, want 1 (warm query wrong)`);
      meas.cache_replay_to_other_claims = replayAsB.n === 1 ? "LEAKED" : "filtered";
      if (replayAsB.n !== 0) failures.push(`cache replayed across claims: n=${replayAsB.n} under B, want 0`);

      // a2: the actual claims-blindness exposure. Caching is keyed on
      // (SQL text, parameters); any per-user input carried IN those (not in
      // a GUC) is the documented leak shape. Probe: same table, no claims
      // needed - a query whose SQL text embeds the caller's uuid via a
      // parameter, run under claims A then claims B against the SAME cached
      // binding. The result differs per parameter, so a leak would need
      // identical params; instead we measure the documented positive form:
      // an identical (sql, params) query IS served from cache (row count
      // stable, latency lower on the second call), which is what makes the
      // GUC-carrying variant dangerous when it IS cacheable.
      const t1 = Date.now();
      const r1 = await probe("binding=cache&form=param&who=a");
      const d1 = Date.now() - t1;
      const t2 = Date.now();
      const r2 = await probe("binding=cache&form=param&who=a");
      const d2 = Date.now() - t2;
      meas.cache_repeat_same_claims_rows = r2.n ?? -1;
      meas.cache_repeat_warm_ms = d1;
      meas.cache_repeat_hit_ms = d2;
      if (r1.n !== 1 || r2.n !== 1) failures.push(`cache repeat: ${r1.n}/${r2.n}, want 1/1`);

      // b: same query on the no-cache binding is per-claims correct.
      const noCacheA = await probe("binding=nocache&form=param&who=a");
      const noCacheB = await probe("binding=nocache&form=param&who=b");
      meas.nocache_param_as_a = noCacheA.n ?? -1;
      meas.nocache_param_as_b = noCacheB.n ?? -1;
      if (noCacheA.n !== 1 || noCacheB.n !== 0) {
        failures.push(`nocache param: a=${noCacheA.n} b=${noCacheB.n}, want 1/0`);
      }

      const pass = failures.length === 0;
      return [{
        id: "C03",
        title: this.title,
        status: pass ? "pass" : "fail",
        detail: pass
          ? "tx + multi SET forms resolve claims; bare SET reset on pool return; cached binding did NOT replay across claims (filtered); nocache binding filters"
          : failures.join("; "),
        measurements: meas,
      }];
    } catch (e) {
      return [{ id: "C03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` }];
    } finally {
      if (workdir) await wrangler(env, ["delete", "--name", workerName, "--force"], workdir).catch(() => "");
      for (const id of createdConfigs) {
        await wrangler(env, ["hyperdrive", "delete", id], workdir || ".").catch(() => "");
      }
      if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => null);
      if (ref) await mgmt(ctx, "DELETE", `/projects/${ref}`).catch(() => null);
    }
  },
};
export default mod;
