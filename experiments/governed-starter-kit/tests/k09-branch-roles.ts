/**
 * K09 - does a project-scoped role on a production project carry to its
 * branches? Measured with a restricted member's own token, once per role.
 *
 * Role assignment has no Management API write below Enterprise (README,
 * docs/ACCESS-CONTROL.md), so the run is in three steps with a human one in the
 * middle:
 *   1. `make roles-setup`  (PVLAB_K09_MODE=setup) creates a prefixed project
 *      (kit-cm-roles-...) with one table and one row, and a persistent branch
 *      (k09-staging), and keeps both.
 *   2. Dashboard, as the org owner: invite the second account with org role
 *      No access and a project-scoped role (Read-only first, then Developer)
 *      on that project only. While there, note whether the project picker
 *      lists the persistent branch as a separate project.
 *   3. `make roles-probe PEER_ROLES=<ref>` with PVLAB_PAT2 (the member's PAT)
 *      in the environment: the owner creates a preview branch (the persistent
 *      one from setup is reused), the member's token probes the project and
 *      both branches, the owner deletes the preview branch. Re-run after
 *      changing the role. `make roles-teardown PEER_ROLES=<ref>` deletes the
 *      persistent branch and the project.
 *
 * Member probes (status codes only, no refs or keys recorded):
 *   K09-control  the member token, its org role (owner listing, when readable)
 *                and the project-scoped role the operator declares (K09_ROLE)
 *   K09a  GET /projects: is the production project listed, are the branch refs
 *   K09b  GET /projects/{prod}/branches
 *   K09c  SQL on production: read-only endpoint SELECT, query endpoint SELECT,
 *         query endpoint DDL
 *   K09d  the same on the persistent branch
 *   K09e  the same on the preview branch
 *   K09f  POST /projects/{prod}/branches (create a branch); deleted if created
 *   K09g  GET /projects/{ref}/api-keys (no reveal) on production and on a branch
 * Anything the member's DDL creates is dropped by the owner.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { api, prefix, provision, sql, teardown } from "../lib/scratch-project";
import { readFileSync } from "node:fs";

const TITLE = "Project-scoped role on production vs its branches, measured with the member's token";
const TABLE_SQL =
  "create table if not exists public.k09_items (id int primary key, name text); " +
  "insert into public.k09_items values (1, 'row one') on conflict do nothing;";

const STAGING = "k09-staging";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mk(id: string, title: string, ok: boolean | "info", detail?: string, measurements?: Record<string, number | string>): TestResult {
  return { id, title, status: ok === "info" ? "info" : ok ? "pass" : "fail", ...(detail ? { detail } : {}), ...(measurements ? { measurements } : {}) };
}

interface Branch {
  id: string;
  ref: string;
  persistent: boolean;
}

async function createBranch(ctx: Ctx, parent: string, name: string, persistent: boolean): Promise<Branch> {
  const c = await api(ctx, "POST", `/projects/${parent}/branches`, { branch_name: name, persistent });
  const j = (c.json ?? {}) as { id?: string; project_ref?: string };
  if (c.status !== 201 || !j.id || !j.project_ref) throw new Error(`branch ${name}: http ${c.status} ${c.text.slice(0, 200)}`);
  for (let i = 0; i < 90; i++) {
    const l = await api(ctx, "GET", `/projects/${parent}/branches`);
    const b = ((Array.isArray(l.json) ? l.json : []) as { id?: string; status?: string; preview_project_status?: string }[]).find((x) => x.id === j.id);
    if (/FAILED/.test(b?.status ?? "")) throw new Error(`branch ${name}: ${b?.status}`);
    if (b?.status === "FUNCTIONS_DEPLOYED" && b?.preview_project_status === "ACTIVE_HEALTHY") break;
    await sleep(10_000);
  }
  // reads on a fresh branch can lag its status
  for (let i = 0; i < 12; i++) {
    try {
      await sql(ctx, j.project_ref, "select 1");
      break;
    } catch {
      await sleep(10_000);
    }
  }
  return { id: j.id, ref: j.project_ref, persistent };
}

async function findBranch(ctx: Ctx, parent: string, name: string): Promise<Branch | undefined> {
  const l = await api(ctx, "GET", `/projects/${parent}/branches`);
  const b = ((Array.isArray(l.json) ? l.json : []) as { id?: string; name?: string; project_ref?: string; persistent?: boolean }[]).find((x) => x.name === name);
  return b?.id && b.project_ref ? { id: b.id, ref: b.project_ref, persistent: !!b.persistent } : undefined;
}

async function deleteBranch(ctx: Ctx, b: Branch): Promise<number> {
  if (b.persistent) await api(ctx, "PATCH", `/branches/${b.id}`, { persistent: false }); // DELETE 4xx on a persistent branch
  const d = await api(ctx, "DELETE", `/branches/${b.id}`);
  return d.status;
}

const REF_RE = /[a-z]{20}/g;

/** Status plus, for a non-2xx, the SQLSTATE (if any) and a short scrubbed reason, so a missing table, a leftover object and a permission refusal are told apart. */
function outcome(r: { status: number; text: string }): string {
  if (r.status >= 200 && r.status < 300) return String(r.status);
  const code = r.text.match(/\b([0-9A-Z]{5}):/)?.[1] ?? "";
  const reason = r.text.replace(REF_RE, "<ref>").replace(/\s+/g, " ").slice(0, 90);
  return `${r.status}${code ? ` ${code}` : ""} ${reason}`.trim();
}

/** Owner control read, then the member's three SQL probes: read-only endpoint SELECT, query endpoint SELECT, query endpoint DDL. */
async function sqlProbes(member: Ctx, owner: Ctx, ref: string): Promise<Record<string, number | string>> {
  const sel = "select count(*)::int as n from public.k09_items";
  const ownerRows = await sql(owner, ref, sel).then((x) => String((x as { n?: number }[])[0]?.n ?? "?")).catch((e) => `error ${(e as Error).message.replace(REF_RE, "<ref>").slice(0, 60)}`);
  await sql(owner, ref, "drop table if exists public.k09_member_probe").catch(() => undefined); // leftover from an earlier run
  const ro = await mgmt(member, "POST", `/projects/${ref}/database/query/read-only`, { query: sel });
  const q = await mgmt(member, "POST", `/projects/${ref}/database/query`, { query: sel });
  const ddl = await mgmt(member, "POST", `/projects/${ref}/database/query`, { query: "create table public.k09_member_probe (id int)" });
  if (ddl.status === 201) await sql(owner, ref, "drop table if exists public.k09_member_probe").catch(() => undefined);
  return { owner_rows: ownerRows, readonly_select: outcome(ro), query_select: outcome(q), query_ddl: outcome(ddl) };
}

const mod: TestModule = {
  id: "K09",
  title: TITLE,
  where: "local",
  requires: ["pat"],
  destructive: true, // creates and deletes branches (and, in setup/teardown mode, the project)
  async run(ctx: Ctx): Promise<TestResult[]> {
    const mode = process.env.PVLAB_K09_MODE ?? "probe";
    const org = ctx.orgs.team ?? "";
    if (!org) return [{ id: "K09", title: TITLE, status: "skip", detail: "PVLAB_ORG_TEAM not set" }];

    if (mode === "setup") {
      if (ctx.peers.mcp) return [{ id: "K09", title: TITLE, status: "skip", detail: "setup creates its own project; unset PVLAB_PEER_MCP" }];
      const s = await provision(ctx, "roles", [], (p) => readFileSync(p, "utf8"), false);
      ctx.log(`K09 setup: project ${s.name} ref ${s.ref} created (kept)`);
      try {
        await sql(ctx, s.ref, TABLE_SQL);
        // Kept, so the invite dialog can be checked for branch entries before the first probe.
        await createBranch(ctx, s.ref, STAGING, true);
      } catch (e) {
        return [mk("K09.setup", "roles project created, branch setup failed", false, `${s.name} kept (ref in the run log); ${(e as Error).message.replace(REF_RE, "<ref>")}`)];
      }
      ctx.log(`K09 setup: persistent branch ${STAGING} kept - grant the member a project-scoped role on the project, then make roles-probe PEER_ROLES=${s.ref}`);
      return [mk("K09.setup", "roles project and persistent branch created and kept", "info", `${s.name} + ${STAGING}; pass PEER_ROLES=<its ref> (printed in the run log)`)];
    }

    const parent = ctx.peers.roles ?? "";
    if (!parent) return [{ id: "K09", title: TITLE, status: "skip", detail: "PVLAB_PEER_ROLES not set - run make roles-setup first" }];
    const p = await api(ctx, "GET", `/projects/${parent}`);
    const name = String((p.json as { name?: string } | undefined)?.name ?? "");
    if (!name.startsWith(prefix())) return [{ id: "K09", title: TITLE, status: "skip", detail: `refusing project "${name}": name lacks the ${prefix()} prefix` }];

    if (mode === "teardown") {
      const kept = await findBranch(ctx, parent, STAGING);
      const bst = kept ? await deleteBranch(ctx, kept).catch(() => 0) : "none";
      const note = await teardown(ctx, { ref: parent, name, adopted: false, url: "", publishableKey: "", secretKey: "", users: {} });
      return [mk("K09.teardown", "roles project and persistent branch removed", "info", `branch delete ${bst}; ${note}`)];
    }

    const pat2 = process.env.PVLAB_PAT2 ?? "";
    if (!pat2) return [{ id: "K09", title: TITLE, status: "skip", detail: "PVLAB_PAT2 (the restricted member's PAT) not set" }];
    const member: Ctx = { ...ctx, pat: pat2 };
    const results: TestResult[] = [];
    const branches: Branch[] = [];
    const deletes: string[] = [];
    const run = Date.now().toString(36);
    try {
      // Leftovers from an aborted run would turn the next create into a name conflict.
      const l0 = await api(ctx, "GET", `/projects/${parent}/branches`);
      for (const b of (Array.isArray(l0.json) ? l0.json : []) as { id?: string; name?: string; project_ref?: string; persistent?: boolean }[]) {
        if (b.id && b.project_ref && /^k09-(preview|by-member)/.test(b.name ?? "")) {
          deletes.push(`leftover ${b.name}: ${await deleteBranch(ctx, { id: b.id, ref: b.project_ref, persistent: !!b.persistent }).catch(() => 0)}`);
        }
      }

      // ---- K09-control: the member token, its org role, the role under test ----
      // The org role comes from the owner's member listing when the member token can read /profile; a scoped PAT may not (SP06:
      // "This endpoint requires a user-scoped access token"). The project-scoped grant is not in the listing, so the operator declares it.
      const prof = await mgmt(member, "GET", "/profile");
      const me = (prof.json ?? {}) as { gotrue_id?: string; primary_email?: string };
      const ml = await mgmt(ctx, "GET", `/organizations/${org}/members`);
      const row = ((Array.isArray(ml.json) ? ml.json : []) as { user_id?: string; email?: string; role_name?: string }[]).find(
        (m) => (me.gotrue_id && m.user_id === me.gotrue_id) || (me.primary_email && m.email === me.primary_email),
      );
      const orgRole = row?.role_name ?? "(unread)";
      const declared = process.env.PVLAB_K09_ROLE ?? "(not declared)";
      const tok = await mgmt(member, "GET", "/projects");
      results.push(
        mk("K09-control", "member token, org role, declared project-scoped role", "info", `projects ${outcome(tok)}; profile ${outcome(prof)}; org role ${orgRole}; declared ${declared}`, {
          org_role: orgRole,
          declared_role: declared,
        }),
      );
      const tag = { org_role: orgRole, declared_role: declared };

      await sql(ctx, parent, TABLE_SQL);
      const persistentB = (await findBranch(ctx, parent, STAGING)) ?? (await createBranch(ctx, parent, STAGING, true)); // kept between roles
      const previewB = await createBranch(ctx, parent, `k09-preview-${run}`, false);
      branches.push(previewB);

      // ---- K09a / K09b: what the member can list ----
      const lp = await mgmt(member, "GET", "/projects");
      const refs = ((Array.isArray(lp.json) ? lp.json : []) as { ref?: string; id?: string }[]).map((x) => x.ref ?? x.id ?? "");
      results.push(
        mk("K09a", "member GET /projects", "info", `${outcome(lp)}; ${refs.length} project(s); production ${refs.includes(parent) ? "listed" : "not listed"}; persistent branch ${refs.includes(persistentB.ref) ? "listed" : "not listed"}; preview branch ${refs.includes(previewB.ref) ? "listed" : "not listed"}`, {
          ...tag,
          http: lp.status,
          count: refs.length,
        }),
      );
      const lb = await mgmt(member, "GET", `/projects/${parent}/branches`);
      results.push(mk("K09b", "member GET /projects/{prod}/branches", "info", `${outcome(lb)}; ${Array.isArray(lb.json) ? lb.json.length : 0} entr(ies)`, { ...tag, http: lb.status }));

      // ---- K09c-e: SQL on production and on both branches ----
      for (const [id, label, ref] of [
        ["K09c", "production", parent],
        ["K09d", "persistent branch", persistentB.ref],
        ["K09e", "preview branch", previewB.ref],
      ] as const) {
        const m = await sqlProbes(member, ctx, ref);
        results.push(mk(id, `member SQL on the ${label}`, "info", `owner rows ${m.owner_rows}; read-only SELECT ${m.readonly_select}; query SELECT ${m.query_select}; query DDL ${m.query_ddl}`, { ...tag, ...m }));
      }

      // ---- K09f: can the member create a branch (production branch already registered by the owner) ----
      const cb = await mgmt(member, "POST", `/projects/${parent}/branches`, { branch_name: `k09-by-member-${run}` });
      const made = (cb.json ?? {}) as { id?: string; project_ref?: string };
      if (cb.status === 201 && made.id) branches.push({ id: made.id, ref: made.project_ref ?? "", persistent: false });
      results.push(mk("K09f", "member POST /projects/{prod}/branches", "info", outcome(cb), { ...tag, http: cb.status }));

      // ---- K09g: key metadata on production and on the preview branch ----
      const kp = await mgmt(member, "GET", `/projects/${parent}/api-keys`);
      const kb = await mgmt(member, "GET", `/projects/${previewB.ref}/api-keys`);
      results.push(mk("K09g", "member GET api-keys (no reveal): production vs the preview branch", "info", `production ${outcome(kp)}; preview branch ${outcome(kb)}`, { ...tag, prod: kp.status, branch: kb.status }));
    } catch (e) {
      results.push(mk("K09.99", "aborted", false, (e as Error).message.replace(REF_RE, "<ref>")));
    } finally {
      for (const b of branches) {
        const st = await deleteBranch(ctx, b).catch(() => 0);
        deletes.push(String(st));
        ctx.log(`branch ${b.id} delete: http ${st}`);
      }
      results.push(mk("K09.cleanup", "run's branches removed (project and persistent branch kept for the next role)", "info", `deletes: ${deletes.join(", ") || "none"}`));
    }
    return results;
  },
};

export default mod;
