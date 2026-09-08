/**
 * A12 - the RBAC half: which member roles a plan actually gives you, and what a
 * "read-only" credential can do to the audit trail when you exercise it rather
 * than infer it from a grant table.
 *
 * A01/A02 measure privileges through `has_table_privilege` and `set local role`,
 * both of which run inside a session that is already `postgres`. This module
 * gets a SEPARATE credential with its own password and connects with it, which
 * is the shape a human member or a CLI session actually has.
 *
 * `POST /v1/projects/{ref}/cli/login-role {read_only}` is a Beta endpoint that
 * mints a temporary login role and returns role + password + ttl_seconds. The
 * password is never written to an artifact: it is passed through PGPASSWORD and
 * scrubbed out of any psql error text.
 *
 *   A12a  GET organizations/{slug}/members per org role: which member roles
 *         exist in each plan's membership, and whether MFA is on
 *   A12b  a read_only login role: connect, read the audit table, try to delete
 *   A12c  a read-write login role: the same three probes
 *   A12d  connect with the minted credential, DELETE the login roles, then
 *         reconnect with the SAME correct password - the only pair that
 *         distinguishes a revoked role from a live one
 *
 * DESTRUCTIVE: creates and deletes database login roles; attempts a delete on
 * auth.audit_log_entries as the read-write role.
 *
 * Not settled by this module: whether a Dashboard member holding the Read-Only
 * ROLE routes through this same database role. The docs say Read-Only SQL runs
 * as `supabase_read_only_user`; assigning that role needs a second human
 * account, so the Dashboard half stays doc-cited.
 */
import { spawnSync } from "node:child_process";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

interface Minted {
  role: string;
  password: string;
  ttl: number;
  status: number;
}

async function mintRole(ctx: Ctx, readOnly: boolean): Promise<Minted> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/cli/login-role`, { read_only: readOnly });
  const j = (r.json ?? {}) as { role?: string; password?: string; ttl_seconds?: number };
  return { role: String(j.role ?? ""), password: String(j.password ?? ""), ttl: Number(j.ttl_seconds ?? 0), status: r.status };
}

/** One psql statement as a given role. Never returns the password. */
function psql(host: string, user: string, password: string, statement: string): { ok: boolean; out: string } {
  const r = spawnSync("psql", [`postgres://${user}@${host}:5432/postgres?sslmode=require`, "-tAc", statement], {
    env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" },
    timeout: 25_000,
    encoding: "utf8",
  });
  const raw = r.status === 0 ? (r.stdout ?? "") : (r.stderr || r.error?.message || "");
  const scrubbed = raw
    .replace(/\s+/g, " ")
    .replaceAll(password, "<pw>")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
    .trim()
    .slice(0, 200);
  return { ok: r.status === 0, out: scrubbed };
}

const mod: TestModule = {
  id: "A12",
  title: "member roles per plan, and what a minted read-only credential can do to the audit table",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const proj = await mgmt(ctx, "GET", `/projects/${ctx.ref}`);
    const region = String((proj.json as { region?: string })?.region ?? ctx.region);
    const pooler = `aws-0-${region}.pooler.supabase.com`;
    const minted: string[] = [];
    // Keep the last credential: the revocation probe has to reconnect with the
    // CORRECT password. The first version of this module used a deliberately
    // wrong one and read the resulting FATAL as proof of revocation, which it
    // is not - that error comes back either way.
    let lastCred: { role: string; password: string } | undefined;

    // A12a - the member surface per org
    const lines: string[] = [];
    const m: Record<string, number | string> = {};
    for (const role of Object.keys(ctx.orgs)) {
      const r = await mgmt(ctx, "GET", `/organizations/${ctx.orgs[role]}/members`);
      const rows = Array.isArray(r.json) ? (r.json as { role_name?: string; mfa_enabled?: boolean }[]) : [];
      const byRole = rows.reduce<Record<string, number>>((a, x) => {
        const k = String(x.role_name ?? "?");
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {});
      const mfa = rows.filter((x) => x.mfa_enabled).length;
      lines.push(`${role}: HTTP ${r.status}, ${rows.length} members, roles ${JSON.stringify(byRole)}, ${mfa} with MFA`);
      m[`${role}_members`] = rows.length;
      m[`${role}_roles`] = Object.keys(byRole).join("|");
    }
    out.push({
      id: "A12a",
      title: "organization members and their roles, per plan",
      status: Object.keys(ctx.orgs).length ? "info" : "skip",
      detail: lines.join(" || ") || "no org roles supplied",
      measurements: m,
      evidence: lines.join("\n"),
    });

    // A12b / A12c - mint a credential and exercise it
    for (const [id, readOnly] of [["A12b", true], ["A12c", false]] as const) {
      const cred = await mintRole(ctx, readOnly);
      if (!cred.role || !cred.password) {
        out.push({
          id,
          title: `${readOnly ? "read_only" : "read-write"} login role: mint`,
          status: "info",
          detail: `POST cli/login-role {read_only:${readOnly}} -> HTTP ${cred.status}; no role/password in the body, so nothing to exercise. ${proj.status >= 300 ? "" : "The endpoint is marked Beta in the spec."}`,
          measurements: { mint_status: cred.status },
        });
        continue;
      }
      minted.push(cred.role);
      lastCred = { role: cred.role, password: cred.password };
      const user = `${cred.role}.${ctx.ref}`;
      const who = psql(pooler, user, cred.password, "select current_user");
      const read = psql(pooler, user, cred.password, "select count(*) from auth.audit_log_entries");
      const del = psql(pooler, user, cred.password, "delete from auth.audit_log_entries");
      out.push({
        id,
        title: `${readOnly ? "read_only" : "read-write"} login role: connect, read the audit table, delete from it`,
        status: who.ok ? (readOnly ? (del.ok ? "fail" : "pass") : "info") : "info",
        detail: `POST cli/login-role {read_only:${readOnly}} -> HTTP ${cred.status}, ttl ${cred.ttl}s. Connected through the session pooler as <role>.<ref>: current_user ${who.ok ? `= ${who.out}` : `FAILED (${who.out})`}. select on auth.audit_log_entries: ${read.ok ? `allowed (${read.out} rows)` : `denied (${read.out})`}. delete: ${del.ok ? "ALLOWED" : `denied (${del.out})`}.`,
        measurements: {
          mint_status: cred.status,
          ttl_seconds: cred.ttl,
          connected: String(who.ok),
          current_user: who.ok ? who.out : "",
          can_read_audit: String(read.ok),
          can_delete_audit: String(del.ok),
        },
        evidence: [who.out, read.out, del.out].join("\n"),
      });
    }

    // A12d - revoke, then reconnect with the CORRECT password. A wrong-password
    // probe cannot distinguish a revoked role from a live one.
    const before = lastCred ? psql(pooler, `${lastCred.role}.${ctx.ref}`, lastCred.password, "select 1") : { ok: false, out: "no credential kept" };
    const rm = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/cli/login-role`);
    const after = lastCred ? psql(pooler, `${lastCred.role}.${ctx.ref}`, lastCred.password, "select 1") : { ok: false, out: "no credential kept" };
    const revoked = before.ok && !after.ok;
    out.push({
      id: "A12d",
      title: "revoking the minted login roles, verified with the correct password",
      status: rm.status < 300 && revoked ? "pass" : "info",
      detail: `the same credential answered ${before.ok ? "OK" : `FAILED (${before.out})`} immediately before revocation. DELETE cli/login-role -> HTTP ${rm.status} (${rm.text.replace(/\s+/g, " ").slice(0, 120)}); ${minted.length} role(s) had been minted. Reconnecting afterwards with the SAME correct password: ${after.ok ? "still OK - the role was not revoked" : after.out}. ${revoked ? "Revocation confirmed: the credential worked before the DELETE and not after." : "Revocation NOT confirmed by this run - read the two probe outcomes above."}`,
      measurements: {
        delete_status: rm.status,
        roles_minted: minted.length,
        worked_before_revoke: String(before.ok),
        worked_after_revoke: String(after.ok),
        revocation_confirmed: String(revoked),
      },
    });

    return out;
  },
};
export default mod;
