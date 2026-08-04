/**
 * C01 - can a per-customer project's users be moved INTO a shared project?
 *
 * The corpus has this runbook in one direction only: shared -> dedicated, one
 * source, one target, as part of promoting a tenant that outgrew the shared
 * tier. A platform consolidating away from project-per-customer runs it the
 * other way and many-to-one, and the two are not symmetric - which is the
 * whole reason this experiment exists.
 *
 * This module establishes the baseline that everything after it depends on:
 * one source, no collisions possible, so a failure here is a failure of the
 * mechanism and not of a merge conflict. Three claims are load-bearing for
 * whether consolidation is a migration or a re-registration:
 *
 *   - the user's uuid survives, so every user_id already stored in the
 *     customer's data keeps pointing at the same person;
 *   - the password survives, so nobody is forced through a reset;
 *   - the tenant claim can be stamped on during the move, since the source
 *     rows have no tenant_id at all (the project WAS the tenant).
 *
 * The last check is the negative one that makes the rest interpretable: the
 * source project is re-read afterwards to confirm the copy took nothing away.
 * A consolidation that cannot be aborted halfway is a different risk profile
 * from one that can.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  PASSWORD,
  adminCreate,
  claims,
  copyTable,
  keys,
  login,
  sql,
  sqlstate,
  waitReady,
} from "../lib/consolidate";

const TENANT = "tenant-a";
const EMAILS = ["c01-alice@lab.invalid", "c01-bob@lab.invalid", "c01-carol@lab.invalid"];

async function seedSource(ctx: Ctx, ref: string): Promise<number> {
  const k = await keys(ctx, ref);
  if (!k.service) return 0;
  let made = 0;
  for (const email of EMAILS) {
    const r = await adminCreate(`${ref}.supabase.co`, k.service, {
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (r.status < 300) made++;
  }
  return made;
}

const mod: TestModule = {
  id: "C01",
  title: "Merging one source project's users into a shared project (SQL copy)",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates users on the source and writes auth rows on the target
  async run(ctx) {
    const srcA = ctx.peers.src_a;
    const shared = ctx.ref;
    if (!srcA) {
      return {
        id: "C01",
        title: this.title,
        status: "skip",
        detail: "PVLAB_PEER_SRC_A not set - this experiment needs the source projects",
      };
    }
    const results: TestResult[] = [];

    await waitReady(ctx, srcA);
    await waitReady(ctx, shared);

    // Start from a known state so a re-run does not measure the last run.
    await sql(ctx, shared, `delete from auth.users where lower(email) like 'c01-%'`);
    await sql(ctx, srcA, `delete from auth.users where lower(email) like 'c01-%'`);

    const made = await seedSource(ctx, srcA);
    const before = await sql(
      ctx,
      srcA,
      `select id::text, email, encrypted_password from auth.users where email like 'c01-%' order by email`,
    );
    const sourceRows = before.rows ?? [];
    results.push({
      id: "C01a",
      title: "Source project holds users with no tenant claim (the pre-consolidation state)",
      status: sourceRows.length === EMAILS.length ? "pass" : "fail",
      detail: `${sourceRows.length} users on the source (${made} created this run)`,
      measurements: { users: sourceRows.length },
    });
    if (!sourceRows.length) return results;

    const copy = await copyTable(ctx, srcA, shared, "auth", "users", `email like 'c01-%'`);
    const landed = await sql(
      ctx,
      shared,
      `select id::text, email, encrypted_password from auth.users where email like 'c01-%' order by email`,
    );
    const targetRows = landed.rows ?? [];
    results.push({
      id: "C01b",
      title: "auth.users rows copy into the target",
      status: copy.result.status < 300 && targetRows.length === sourceRows.length ? "pass" : "fail",
      detail:
        copy.result.status < 300
          ? `${targetRows.length}/${copy.read} rows landed over ${copy.cols} non-generated columns`
          : `insert failed: ${copy.result.error?.slice(0, 160)}`,
      measurements: {
        read: copy.read,
        landed: targetRows.length,
        columns: copy.cols,
        sqlstate: sqlstate(copy.result),
      },
      evidence: copy.result.error?.slice(0, 300),
    });

    const idsMatch =
      targetRows.length === sourceRows.length &&
      sourceRows.every((s) => targetRows.some((t) => t.id === s.id));
    results.push({
      id: "C01c",
      title: "The user's uuid survives the move, so stored user_id references stay valid",
      status: idsMatch ? "pass" : "fail",
      detail: idsMatch
        ? "every source uuid is present on the target"
        : "uuids differ - every user_id in the customer's data would need remapping",
      measurements: { matched: idsMatch ? sourceRows.length : 0 },
    });

    // The source rows carry no tenant_id: the project was the tenant. Stamping
    // it during the move is the step that has no counterpart in the promotion
    // runbook, where the claim already exists.
    const stamp = await sql(
      ctx,
      shared,
      `update auth.users
          set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('tenant_id', '${TENANT}')
        where email like 'c01-%'`,
    );
    const anon = (await keys(ctx, shared)).anon;
    if (!anon) {
      results.push({ id: "C01z", title: "key fetch", status: "fail", detail: "no anon key on target" });
      return results;
    }

    const l = await login(`${shared}.supabase.co`, anon, EMAILS[0]!);
    const token = typeof l.json.access_token === "string" ? l.json.access_token : undefined;
    results.push({
      id: "C01d",
      title: "The moved user logs in at the shared project with the ORIGINAL password",
      status: token ? "pass" : "fail",
      detail: token
        ? "password login succeeds - the bcrypt hash travelled with the row"
        : `login refused: HTTP ${l.status} ${String(l.json.error_code ?? l.json.error ?? "")}`,
      measurements: { status: l.status },
      evidence: token ? undefined : l.text.slice(0, 200),
    });

    if (token) {
      const c = claims(token);
      const meta = (c.app_metadata ?? {}) as Record<string, unknown>;
      results.push({
        id: "C01e",
        title: "The tenant claim stamped on during the move is in the issued token",
        status: meta.tenant_id === TENANT ? "pass" : "fail",
        detail: `iss=${String(c.iss ?? "")} sub=${String(c.sub ?? "").slice(0, 8)} tenant_id=${String(meta.tenant_id ?? "absent")}`,
        measurements: {
          tenant_id: String(meta.tenant_id ?? "absent"),
          sub_matches_source: String(sourceRows.some((s) => s.id === c.sub)),
          stamp_status: stamp.status,
        },
      });
    }

    // No auth.identities row was copied. If login works anyway, an identity
    // copy is not on the critical path for a password-only consolidation -
    // worth knowing before writing a four-table runbook.
    const ident = await sql(
      ctx,
      shared,
      `select count(*)::int as n from auth.identities i
         join auth.users u on u.id = i.user_id where u.email like 'c01-%'`,
    );
    results.push({
      id: "C01f",
      title: "Login worked without copying auth.identities",
      status: token && Number(ident.rows?.[0]?.n ?? -1) === 0 ? "pass" : "info",
      detail: `${String(ident.rows?.[0]?.n ?? "?")} identity rows on the target for these users`,
      measurements: { identities: Number(ident.rows?.[0]?.n ?? -1) },
    });

    // Control: the copy must be non-destructive, or a consolidation cannot be
    // aborted after the first customer is moved.
    const srcKeys = await keys(ctx, srcA);
    const stillThere = await login(`${srcA}.supabase.co`, srcKeys.anon ?? "", EMAILS[0]!);
    results.push({
      id: "C01g",
      title: "Control: the source project still authenticates the same user",
      status: typeof stillThere.json.access_token === "string" ? "pass" : "fail",
      detail: `source login HTTP ${stillThere.status} - the move is a copy, not a cut`,
      measurements: { status: stillThere.status },
    });

    return results;
  },
};
export default mod;
