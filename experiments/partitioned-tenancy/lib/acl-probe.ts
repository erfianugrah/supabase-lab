/**
 * Live check of lib/acl.ts restoreDefaultAclSql in the direction PT01 never
 * exercises on its own: recorded = the revoked state, current = the legacy
 * grant. It is the case where the earlier PT01z (a blanket `grant all`) left
 * the legacy grant behind on a project whose default is the revoked state.
 *
 *   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> bun lib/acl-probe.ts > out/<date>/acl-probe-<stamp>.json
 *
 * Creates one throwaway project (lib/project.ts, PVLAB_PT_PREFIX), deletes it
 * at the end, and prints JSON with no project ref or org slug in it.
 *   1. read the fresh rows (legacy grant on 2026-10-23)
 *   2. apply the data-api-defaults DD01c revoke, read: the "recorded" state
 *   3. apply the earlier PT01z statements (grant all on tables, sequences)
 *   4. restoreDefaultAclSql(recorded, current), apply, read, compare
 */
import type { Ctx } from "../../../harness/src/types.js";
import { asRows, compareDefaultAcl, defaultAclSql, restoreDefaultAclSql } from "./acl.js";
import { ensureProject, sqlOk, teardownProject } from "./project.js";

const REVOKE_DEFAULTS = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;`;
const OLD_PT01Z = `alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`;

const ctx = { pat: process.env.SUPABASE_ACCESS_TOKEN, orgs: { pro: process.env.PVLAB_ORG_PRO } } as unknown as Ctx;
const out: Record<string, unknown> = { probe: "partitioned-tenancy acl-probe", started: new Date().toISOString() };
try {
  const p = await ensureProject(ctx);
  out.pg_version = p.pgVersion;
  const read = async () => asRows(await sqlOk(ctx, p.ref, defaultAclSql()));
  out.fresh = await read();
  await sqlOk(ctx, p.ref, REVOKE_DEFAULTS);
  const recorded = await read();
  out.recorded_after_dd01c_revoke = recorded;
  await sqlOk(ctx, p.ref, OLD_PT01Z);
  const current = await read();
  out.after_old_pt01z_grant_all = current;
  out.old_pt01z_vs_recorded = compareDefaultAcl(recorded, current);
  const restore = restoreDefaultAclSql(recorded, current);
  out.restore_sql = restore.split("\n");
  if (restore) await sqlOk(ctx, p.ref, restore);
  const back = await read();
  out.after_restore = back;
  out.restore_vs_recorded = compareDefaultAcl(recorded, back);
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e);
} finally {
  const t = await teardownProject(ctx as Ctx);
  out.teardown = { delete_status: t.deleteStatus, gone_s: t.goneS };
  out.finished = new Date().toISOString();
  console.log(JSON.stringify(out, null, 2));
}
