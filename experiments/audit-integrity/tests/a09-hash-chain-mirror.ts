/**
 * A09 - the pattern people reach for when they learn the audit table is
 * writable: mirror every entry into an append-only table with a hash chain.
 * Does it work on a managed project, and what does it actually buy?
 *
 * Managed project, PAT (so every statement runs as `postgres`, the same
 * identity an attacker with the database password holds - which is the point).
 * The mirror is fed by a trigger on auth.audit_log_entries, which is only
 * possible because the ACL grants `postgres` the TRIGGER privilege on a table
 * owned by supabase_auth_admin.
 *
 *   A09a  install: schema, chained table, SECURITY DEFINER trigger function,
 *         trigger on auth.audit_log_entries
 *   A09b  a REAL auth event (GoTrue inserting as supabase_auth_admin) fires the
 *         trigger and lands in the mirror with a linked hash
 *   A09e  delete the LAST mirror row -> the chain still verifies. A chain links
 *         each row to the one before it, so lopping off the tail leaves a
 *         self-consistent chain and the verifier stays quiet. The 2026-09-08
 *         run found this by accident: with a 2-row mirror, "the second row" WAS
 *         the tail, and the run recorded no break where one was expected.
 *   A09c  delete an INTERIOR mirror row -> the chain breaks and the verifier
 *         names the first broken link
 *   A09d  the honest limit: the same identity that broke the chain can rebuild
 *         every hash, and the verifier goes quiet again. The chain is only
 *         evidence if the head hash left the database.
 *
 * DESTRUCTIVE: creates and drops a schema, a function and a trigger on
 * auth.audit_log_entries; creates and deletes an auth user.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys } from "../../../harness/src/platform.js";
import { auditCopyEnabled, createConfirmedUser, deleteUser, nonce, passwordLogin, sqlRows, sqlTry, waitFor } from "../lib/audit.js";

const mod: TestModule = {
  id: "A09",
  title: "a hash-chained mirror of the audit table: does it install, does it catch a delete, and what does it not do",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const keys = await fetchKeys(ctx);
    const tag = nonce();
    let userId = "";
    const userIds: string[] = [];
    // The trigger can only fire on an INSERT that GoTrue performs, and GoTrue
    // performs none while audit_log_disable_postgres is true. So the mirror
    // rows are gated on the same Dashboard-only switch as A05e and A08b; the
    // install and the rehash halves are measurable either way.
    const copy = await auditCopyEnabled(ctx);
    try {
      // A09a - install. sha256() is built in since Postgres 11, so the chain
      // needs no extension.
      const install = await sqlTry(
        ctx,
        `create schema if not exists audit_mirror;
         create table if not exists audit_mirror.entries (
           seq bigserial primary key,
           entry_id uuid not null,
           payload json,
           entry_at timestamptz,
           ip text,
           prev_hash text,
           hash text not null
         );
         create or replace function audit_mirror.capture() returns trigger
           language plpgsql security definer set search_path = '' as $fn$
         declare prev text; body text;
         begin
           select e.hash into prev from audit_mirror.entries e order by e.seq desc limit 1;
           body := coalesce(prev, 'genesis') || new.id::text || coalesce(new.payload::text, '') ||
                   coalesce(new.created_at::text, '') || coalesce(new.ip_address, '');
           insert into audit_mirror.entries(entry_id, payload, entry_at, ip, prev_hash, hash)
             values (new.id, new.payload, new.created_at, new.ip_address, prev,
                     encode(sha256(convert_to(body, 'utf8')), 'hex'));
           return null;
         end $fn$;
         create or replace function audit_mirror.verify(out first_break bigint, out checked bigint)
           language plpgsql as $fn$
         declare r record; prev text := null; body text; calc text;
         begin
           checked := 0;
           for r in select * from audit_mirror.entries order by seq loop
             body := coalesce(prev, 'genesis') || r.entry_id::text || coalesce(r.payload::text, '') ||
                     coalesce(r.entry_at::text, '') || coalesce(r.ip, '');
             calc := encode(sha256(convert_to(body, 'utf8')), 'hex');
             checked := checked + 1;
             if calc <> r.hash and first_break is null then first_break := r.seq; end if;
             prev := r.hash;
           end loop;
         end $fn$;
         grant usage on schema audit_mirror to supabase_auth_admin;
         drop trigger if exists audit_mirror_capture on auth.audit_log_entries;
         create trigger audit_mirror_capture after insert on auth.audit_log_entries
           for each row execute function audit_mirror.capture();`,
      );
      const tg = await sqlRows(ctx, `select count(*)::int as n from pg_trigger where tgrelid = 'auth.audit_log_entries'::regclass and tgname = 'audit_mirror_capture'`);
      out.push({
        id: "A09a",
        title: "install a chained mirror fed by a trigger on the audit table",
        status: install.ok && Number(tg[0]?.n) === 1 ? "pass" : "fail",
        detail: install.ok
          ? `schema, chained table, SECURITY DEFINER capture function, verifier and trigger created; ${String(tg[0]?.n)} trigger now on auth.audit_log_entries. A tenant CAN attach a trigger to the Auth server's own table - the ACL grants postgres the TRIGGER privilege.`
          : `install failed: ${install.error}`,
        measurements: { install_ok: String(install.ok), triggers_on_audit_table: Number(tg[0]?.n ?? 0) },
      });

      // A09b - a real GoTrue write fires it
      // Two users, because each create-plus-login writes two audit rows and the
      // interior-deletion case needs a row that is neither the first nor the
      // last. A 2-row mirror cannot distinguish an interior delete from a tail
      // delete, which is exactly how the first run misreported A09c.
      const pw = `A09-${tag}-Xy!7`;
      const emails = [`a09-${tag}-a@example.com`, `a09-${tag}-b@example.com`];
      const ids: string[] = [];
      let login = { status: 0 };
      for (const email of emails) {
        const u = await createConfirmedUser(ctx, keys.service, email, pw);
        if (u.id) {
          ids.push(u.id);
          userIds.push(u.id);
          login = await passwordLogin(ctx, keys.anon, email, pw);
        }
      }
      userId = ids[0] ?? "";
      const u = { status: login.status, attempts: 1 };
      const mirrored = await waitFor(
        async () => Number((await sqlRows(ctx, `select count(*)::int as n from audit_mirror.entries where payload::text like '%a09-${tag}-%'`))[0]?.n ?? 0) > 0,
        120_000,
        5000,
      );
      const rows = await sqlRows(ctx, "select count(*)::int as n, min(seq) as lo, max(seq) as hi from audit_mirror.entries");
      const v1 = await sqlRows(ctx, "select first_break, checked from audit_mirror.verify()");
      out.push({
        id: "A09b",
        title: "a real auth event reaches the mirror through the trigger",
        status: mirrored.ok ? "pass" : copy.enabled ? "fail" : "skip",
        detail: !copy.enabled
          ? `not measurable on this project: audit_log_disable_postgres=${copy.raw}, so GoTrue writes no row to auth.audit_log_entries and an AFTER INSERT trigger has nothing to fire on. The mirror pattern is only a control on a project where the in-database copy is switched on. Enable it in the Dashboard and re-run.`
          : `admin user create -> HTTP ${u.status}, password login -> HTTP ${login.status}; the mirror ${mirrored.ok ? `captured the tagged entry ${mirrored.elapsedS}s later` : `captured nothing within ${mirrored.elapsedS}s`}. Mirror holds ${String(rows[0]?.n)} rows (seq ${String(rows[0]?.lo)}..${String(rows[0]?.hi)}); verifier: ${String(v1[0]?.checked)} rows checked, first break ${String(v1[0]?.first_break ?? "none")}. GoTrue writes as supabase_auth_admin and the SECURITY DEFINER function still records it.`,
        measurements: {
          create_status: u.status,
          login_status: login.status,
          mirrored: String(mirrored.ok),
          mirror_lag_s: mirrored.elapsedS,
          mirror_rows: Number(rows[0]?.n ?? 0),
          verify_checked: Number(v1[0]?.checked ?? 0),
          verify_break: String(v1[0]?.first_break ?? "none"),
        },
      });

      // A09e - the tail first, while the chain is still intact.
      const rowsNow = await sqlRows(ctx, "select seq from audit_mirror.entries order by seq");
      const seqs = rowsNow.map((r) => Number(r.seq));
      const tail = seqs.length ? (seqs[seqs.length - 1] ?? 0) : 0;
      const cutTail = tail ? await sqlTry(ctx, `delete from audit_mirror.entries where seq = ${tail}`) : { ok: false, error: "mirror empty", rows: [], status: 0 };
      const vTail = await sqlRows(ctx, "select first_break, checked from audit_mirror.verify()");
      out.push({
        id: "A09e",
        title: "delete the LAST mirror row: does the verifier notice",
        status: !copy.enabled ? "skip" : cutTail.ok && vTail[0]?.first_break === null ? "pass" : "info",
        detail: !copy.enabled
          ? "not measurable: the mirror is empty because the in-database copy is off (A09b)"
          : cutTail.ok
          ? `deleted the tail (seq ${tail}) of a ${seqs.length}-row mirror; verifier reports first break ${String(vTail[0]?.first_break ?? "none")} over ${String(vTail[0]?.checked)} rows. Each row links to the one BEFORE it, so removing the newest rows leaves a chain that still recomputes end to end. A chain detects an edit or an interior removal; it does not detect truncation, and truncation is what someone hiding a recent event would do.`
          : `could not delete the tail: ${cutTail.error}`,
        measurements: { tail_seq: tail, mirror_rows_before_tail_cut: seqs.length, verify_break_after_tail_delete: String(vTail[0]?.first_break ?? "none"), verify_checked_tail: Number(vTail[0]?.checked ?? 0) },
      });

      // A09c - now an INTERIOR row, which needs at least 3 remaining.
      const left = (await sqlRows(ctx, "select seq from audit_mirror.entries order by seq")).map((r) => Number(r.seq));
      const vseq = left.length >= 3 ? (left[1] ?? 0) : 0;
      const cut = vseq
        ? await sqlTry(ctx, `delete from audit_mirror.entries where seq = ${vseq}`)
        : { ok: false, error: `only ${left.length} rows remain, so no row is interior - an interior delete needs 3`, rows: [], status: 0 };
      const v2 = await sqlRows(ctx, "select first_break, checked from audit_mirror.verify()");
      out.push({
        id: "A09c",
        title: "delete an INTERIOR mirror row: does the verifier notice",
        status: !copy.enabled ? "skip" : !vseq ? "info" : cut.ok && v2[0]?.first_break !== null ? "pass" : "info",
        detail: !copy.enabled
          ? "not measurable: the mirror is empty because the in-database copy is off (A09b)"
          : !vseq
          ? `not measurable: ${cut.error}`
          : `deleted interior mirror seq ${vseq} of ${left.length} remaining; verifier now reports first break at seq ${String(v2[0]?.first_break ?? "none")} over ${String(v2[0]?.checked)} rows. A row removed from the middle cannot be removed quietly - the next row's prev_hash no longer recomputes.`,
        measurements: { deleted_seq: vseq, rows_at_interior_cut: left.length, verify_break_after_delete: String(v2[0]?.first_break ?? "none"), verify_checked: Number(v2[0]?.checked ?? 0) },
      });

      // A09d - and rebuild it, which is the limit
      const head0 = await sqlRows(ctx, "select hash from audit_mirror.entries order by seq desc limit 1");
      const rebuild = await sqlTry(
        ctx,
        `do $$
         declare r record; prev text := null; body text;
         begin
           for r in select * from audit_mirror.entries order by seq loop
             body := coalesce(prev, 'genesis') || r.entry_id::text || coalesce(r.payload::text, '') ||
                     coalesce(r.entry_at::text, '') || coalesce(r.ip, '');
             update audit_mirror.entries
                set prev_hash = prev, hash = encode(sha256(convert_to(body, 'utf8')), 'hex')
              where seq = r.seq;
             prev := encode(sha256(convert_to(body, 'utf8')), 'hex');
           end loop;
         end $$;`,
      );
      const v3 = await sqlRows(ctx, "select first_break, checked from audit_mirror.verify()");
      const head1 = await sqlRows(ctx, "select hash from audit_mirror.entries order by seq desc limit 1");
      const h0 = String(head0[0]?.hash ?? "");
      const h1 = String(head1[0]?.hash ?? "");
      out.push({
        id: "A09d",
        title: "the same identity rebuilds the chain and the verifier goes quiet",
        status: !copy.enabled ? "skip" : rebuild.ok && v3[0]?.first_break === null ? "pass" : "info",
        detail: !copy.enabled
          ? "not measurable: a rehash over an empty mirror proves nothing (A09b)"
          : `rehash of every row -> ${rebuild.ok}; verifier now reports first break ${String(v3[0]?.first_break ?? "none")} over ${String(v3[0]?.checked)} rows. The head hash moved from ${h0.slice(0, 12)}... to ${h1.slice(0, 12)}..., so the ONE thing that survives an owner with a rehash loop is a head hash that was copied out of the database before the tampering. In-database immutability against the database owner does not exist; off-box anchoring is the control.`,
        measurements: {
          rebuild_ok: String(rebuild.ok),
          verify_break_after_rebuild: String(v3[0]?.first_break ?? "none"),
          head_hash_changed: String(h0 !== h1),
          head_before: h0.slice(0, 16),
          head_after: h1.slice(0, 16),
          postgres_copy_enabled: String(copy.enabled),
        },
      });
    } catch (e) {
      out.push({ id: "A09err", title: "A09 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sqlTry(ctx, "drop trigger if exists audit_mirror_capture on auth.audit_log_entries");
      await sqlTry(ctx, "drop schema if exists audit_mirror cascade");
      for (const id of userIds) await deleteUser(ctx, keys.service, id).catch(() => 0);
      const leftTriggers = await sqlRows(ctx, `select count(*)::int as n from pg_trigger where tgrelid = 'auth.audit_log_entries'::regclass and not tgisinternal`).catch(() => []);
      out.push({ id: "A09z", title: "cleanup", status: "pass", detail: `trigger and schema dropped (${String(leftTriggers[0]?.n ?? "?")} user triggers left on the audit table); ${userIds.length} test user(s) deleted` });
    }
    return out;
  },
};
export default mod;
