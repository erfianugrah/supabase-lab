/**
 * A02 - holding a privilege and exercising it are different claims. This runs
 * the actual statements as each role a tenant can reach.
 *
 * Managed project, PAT (the query endpoint runs as `postgres`, which is the
 * identity behind the Dashboard SQL Editor and the Management API alike).
 * `set local role` inside one transaction is how each role is exercised
 * without a separate connection - the whole statement string runs in ONE
 * transaction on this endpoint, so a subtransaction per probe (BEGIN/EXCEPTION
 * inside the DO block) is what isolates a denial from the next probe.
 *
 *   A02a  matrix: {postgres, service_role, authenticated, anon} x
 *         {select, insert, update, delete, truncate} -> ALLOWED or the SQLSTATE text
 *   A02b  forging: an entry that GoTrue never wrote, inserted as postgres,
 *         read back, then removed
 *   A02c  can postgres rewrite history in place (UPDATE the ip_address and the
 *         payload action of an existing row)
 *
 * DESTRUCTIVE: inserts, updates, deletes and TRUNCATEs auth.audit_log_entries
 * on a throwaway project. Run before A05/A08, which need their own events.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { nonce, sqlRows, sqlTry, tableCount } from "../lib/audit.js";

// supabase_read_only_user is the identity a Dashboard Read-Only member's SQL
// runs as, and dashboard_user is the other role the ACL grants full write to;
// both belong in an exercised matrix rather than a grant lookup.
const ROLES = ["service_role", "authenticated", "anon", "supabase_read_only_user", "dashboard_user", "postgres"];
const OPS = ["select", "insert", "update", "delete", "truncate"];

const mod: TestModule = {
  id: "A02",
  title: "tamper matrix: which roles can actually insert, rewrite, delete and truncate the audit table",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const marker = `a02_probe_${nonce()}`;

    // A02a - the matrix, one subtransaction per cell
    const probe = `
create temp table a02(actor text, op text, outcome text);
do $$
declare r text; o text; msg text;
begin
  foreach r in array array[${ROLES.map((x) => `'${x}'`).join(",")}] loop
    foreach o in array array[${OPS.map((x) => `'${x}'`).join(",")}] loop
      begin
        execute format('set local role %I', r);
        if o = 'select' then
          execute 'select 1 from auth.audit_log_entries limit 1';
        elsif o = 'insert' then
          execute 'insert into auth.audit_log_entries(instance_id, id, payload, created_at, ip_address) values (''00000000-0000-0000-0000-000000000000'', gen_random_uuid(), ''{"action":"${marker}"}'', now(), ''203.0.113.9'')';
        elsif o = 'update' then
          execute 'update auth.audit_log_entries set ip_address = ''0.0.0.0'' where payload->>''action'' = ''${marker}''';
        elsif o = 'delete' then
          execute 'delete from auth.audit_log_entries where payload->>''action'' = ''${marker}''';
        elsif o = 'truncate' then
          execute 'truncate auth.audit_log_entries';
        end if;
        execute 'reset role';
        insert into a02 values (r, o, 'ALLOWED');
      exception when others then
        msg := sqlerrm;
        execute 'reset role';
        insert into a02 values (r, o, 'DENIED: ' || msg);
      end;
    end loop;
  end loop;
end $$;
select actor, op, outcome from a02
order by actor, case op when 'select' then 1 when 'insert' then 2 when 'update' then 3 when 'delete' then 4 else 5 end;`;
    const m = await sqlTry(ctx, probe);
    const cells = m.rows as { actor: string; op: string; outcome: string }[];
    const allowed = (r: string) => cells.filter((c) => c.actor === r && c.outcome === "ALLOWED").map((c) => c.op);
    const denialText = [...new Set(cells.filter((c) => c.outcome !== "ALLOWED").map((c) => c.outcome))];
    // A denial has two very different causes here and collapsing them would
    // misreport the result: "permission denied for table" means the role was
    // assumed and refused, while "permission denied to set role" means the
    // session could not become that role at all - the postgres role is not a
    // member of dashboard_user or supabase_read_only_user. For those two the
    // grant read in A01b is the evidence, not this matrix.
    const unassumable = [...new Set(cells.filter((c) => /permission denied to set role/.test(c.outcome)).map((c) => c.actor))];
    const exercised = ROLES.filter((r) => !unassumable.includes(r));
    out.push({
      id: "A02a",
      title: "matrix: role x operation against auth.audit_log_entries",
      status: m.ok ? "info" : "fail",
      detail: m.ok
        ? `exercised (${exercised.join(", ")}): ` +
          exercised.map((r) => `${r}=${allowed(r).join("/") || "nothing"}`).join("; ") +
          (unassumable.length
            ? `. NOT exercisable from a postgres session - "permission denied to set role": ${unassumable.join(", ")}; the postgres role is not a member of them, so their privileges are the A01b grant read (dashboard_user holds all five, supabase_read_only_user holds select only) and the Dashboard connects as them directly rather than by SET ROLE.`
            : "") +
          ` Distinct denial: ${denialText.map((d) => d.replace(/^DENIED: /, "")).join(" | ") || "none"}.`
        : `matrix did not run: ${m.error}`,
      measurements: {
        cells: cells.length,
        postgres_allowed: allowed("postgres").length,
        dashboard_user_allowed: allowed("dashboard_user").join("/") || "none",
        read_only_user_allowed: allowed("supabase_read_only_user").join("/") || "none",
        service_role_allowed: allowed("service_role").length,
        authenticated_allowed: allowed("authenticated").length,
        anon_allowed: allowed("anon").length,
        denial_kinds: denialText.length,
        roles_exercised: exercised.length,
        roles_unassumable: unassumable.join("|") || "none",
      },
      evidence: cells.map((c) => `${c.actor}\t${c.op}\t${c.outcome}`).join("\n"),
    });

    // A02b - forgery: a row GoTrue never wrote
    const forged = `a02_forged_${nonce()}`;
    const ins = await sqlTry(
      ctx,
      `insert into auth.audit_log_entries(instance_id, id, payload, created_at, ip_address)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
               '{"action":"login","actor_username":"ceo@example.com","traits":{"provider":"email"},"forge_marker":"${forged}"}',
               now() - interval '3 days', '198.51.100.7')`,
    );
    const back = ins.ok ? await sqlRows(ctx, `select id::text, created_at::text, ip_address, payload->>'actor_username' as actor from auth.audit_log_entries where payload->>'forge_marker' = '${forged}'`) : [];
    const cleaned = ins.ok ? await sqlTry(ctx, `delete from auth.audit_log_entries where payload->>'forge_marker' = '${forged}'`) : { ok: false, error: "not inserted", rows: [], status: 0 };
    out.push({
      id: "A02b",
      title: "forging an audit entry GoTrue never wrote",
      status: ins.ok && back.length === 1 ? "info" : "fail",
      detail: ins.ok
        ? `insert accepted; read back ${back.length} row with a chosen actor (${String(back[0]?.actor)}), a chosen source IP and a created_at three days in the past. Removed afterwards: ${cleaned.ok}. The table has no FK to auth.users and no trigger, so nothing reconciles a forged row against a real user.`
        : `insert refused: ${ins.error}`,
      measurements: {
        forge_accepted: String(ins.ok),
        rows_read_back: back.length,
        backdated: String(Boolean(back[0]?.created_at)),
        removed: String(cleaned.ok),
      },
      evidence: back.map((r) => JSON.stringify(r)).join("\n"),
    });

    // A02c - rewriting an existing row in place
    const seed = `a02_seed_${nonce()}`;
    await sqlTry(
      ctx,
      `insert into auth.audit_log_entries(instance_id, id, payload, created_at, ip_address)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{"action":"${seed}"}', now(), '203.0.113.1')`,
    );
    const upd = await sqlTry(
      ctx,
      `update auth.audit_log_entries
          set ip_address = '10.0.0.1',
              payload = jsonb_set(payload::jsonb, '{action}', '"logout"')::json
        where payload->>'action' = '${seed}'`,
    );
    const after = await sqlRows(ctx, `select ip_address, payload->>'action' as action from auth.audit_log_entries where ip_address = '10.0.0.1'`);
    await sqlTry(ctx, `delete from auth.audit_log_entries where ip_address = '10.0.0.1'`);
    const remaining = await tableCount(ctx);
    out.push({
      id: "A02c",
      title: "rewriting an existing entry in place (source IP and action)",
      status: upd.ok ? "info" : "fail",
      detail: upd.ok
        ? `UPDATE accepted: the row's source IP and its action were both rewritten (${after.length} row now reads action=${String(after[0]?.action)} from 10.0.0.1). An audit row is a plain heap row - no immutability, no version, no updated_at to notice the edit by. Table left at ${remaining} rows.`
        : `UPDATE refused: ${upd.error}`,
      measurements: { update_accepted: String(upd.ok), rows_rewritten: after.length, table_rows_after: remaining },
    });

    return out;
  },
};
export default mod;
