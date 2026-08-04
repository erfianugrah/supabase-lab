/**
 * C02 - what happens when two customers share a user.
 *
 * This is the failure mode that has no analogue in the promotion direction.
 * Splitting a shared project can never produce a duplicate; merging two
 * projects that were provisioned independently can, because each ran its own
 * GoTrue and neither could have known about the other's address book. Whenever
 * the platform's end customers serve overlapping populations, one person
 * holding an account at two of them is not an edge case.
 *
 * Four things are worth knowing before planning a consolidation, and only the
 * first is guessable from the schema:
 *
 *   1. that a duplicate is refused at all, and by which constraint;
 *   2. whether the refusal costs you the one row or the whole customer -
 *      a single INSERT is atomic, so a merge written the obvious way loses
 *      every user of that customer, not just the conflicting one;
 *   3. what the survivable workaround costs the affected human;
 *   4. whether the constraint is case-sensitive, because a raw SQL copy does
 *      not normalise the way a signup does. If it is, two rows that GoTrue
 *      considers the same address can both land, and the merge appears to
 *      succeed.
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

const DUP = "c02-dup@lab.invalid";
const ONLY_B = "c02-dave@lab.invalid";

async function seed(ctx: Ctx, ref: string, emails: string[]): Promise<void> {
  const k = await keys(ctx, ref);
  if (!k.service) return;
  for (const email of emails) {
    await adminCreate(`${ref}.supabase.co`, k.service, {
      email,
      password: PASSWORD,
      email_confirm: true,
    });
  }
}

const mod: TestModule = {
  id: "C02",
  title: "A user who exists in two source projects blocks the merge",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true,
  async run(ctx) {
    const srcA = ctx.peers.src_a;
    const srcB = ctx.peers.src_b;
    const shared = ctx.ref;
    if (!srcA || !srcB) {
      return {
        id: "C02",
        title: this.title,
        status: "skip",
        detail: "needs PVLAB_PEER_SRC_A and PVLAB_PEER_SRC_B",
      };
    }
    const results: TestResult[] = [];

    await waitReady(ctx, srcB);
    for (const ref of [srcA, srcB, shared]) {
      await sql(ctx, ref, `delete from auth.users where lower(email) like 'c02-%'`);
    }
    await seed(ctx, srcA, [DUP]);
    await seed(ctx, srcB, [DUP, ONLY_B]);

    // Report the constraint before provoking it, so the mechanism is on record
    // even if the insert behaves unexpectedly.
    // Match on the indexed COLUMN LIST, not on the word "email" anywhere in
    // the definition: auth.users also carries unique indexes over
    // email_change_token_current and email_change_token_new, and an ilike on
    // '%email%' returns those instead of the one the merge collides with.
    const idx = await sql(
      ctx,
      shared,
      `select indexdef from pg_indexes
        where schemaname = 'auth' and tablename = 'users'
          and indexdef ~ 'UNIQUE INDEX .* USING btree \\(email\\)'`,
    );
    const defs = (idx.rows ?? []).map((r) => String(r.indexdef));
    results.push({
      id: "C02a",
      title: "The uniqueness the merge has to satisfy",
      status: defs.length ? "info" : "fail",
      detail: defs.length ? defs.join(" | ").slice(0, 240) : "no unique index on auth.users.email found",
      measurements: { indexes: defs.length },
      evidence: defs.join("\n"),
    });

    const first = await copyTable(ctx, srcA, shared, "auth", "users", `email like 'c02-%'`);
    results.push({
      id: "C02b",
      title: "The first customer merges cleanly",
      status: first.result.status < 300 ? "pass" : "fail",
      detail: `${first.read} row(s) from source A, HTTP ${first.result.status}`,
      measurements: { rows: first.read, status: first.result.status },
    });

    // Source B holds two users, one of whom already exists on the target.
    const clash = await copyTable(ctx, srcB, shared, "auth", "users", `email like 'c02-%'`);
    const after = await sql(
      ctx,
      shared,
      `select count(*)::int as n from auth.users where email like 'c02-%'`,
    );
    const landed = Number(after.rows?.[0]?.n ?? -1);
    results.push({
      id: "C02c",
      title: "The second customer's merge is refused on the duplicate address",
      status: clash.result.status >= 400 ? "pass" : "fail",
      detail:
        clash.result.status >= 400
          ? `refused: ${sqlstate(clash.result)} ${clash.result.error?.slice(0, 140)}`
          : "the duplicate was ACCEPTED - two rows now share an address GoTrue treats as one",
      measurements: {
        status: clash.result.status,
        sqlstate: sqlstate(clash.result),
        read: clash.read,
      },
      evidence: clash.result.error?.slice(0, 300),
    });

    results.push({
      id: "C02d",
      title: "One conflicting row costs the whole customer, not just that row",
      status: landed === 1 ? "pass" : "info",
      detail: `${landed} of ${1 + clash.read} users on the target - source B contributed ${landed - 1} of its ${clash.read}`,
      measurements: { on_target: landed, offered: clash.read },
    });

    // Workaround 1: merge everyone except the conflict. The user is simply
    // absent from the consolidated platform for that customer.
    const skipped = await copyTable(
      ctx,
      srcB,
      shared,
      "auth",
      "users",
      `email like 'c02-%' and email <> '${DUP}'`,
    );
    const afterSkip = await sql(
      ctx,
      shared,
      `select count(*)::int as n from auth.users where email like 'c02-%'`,
    );
    results.push({
      id: "C02e",
      title: "Excluding the conflict lets the rest of the customer through",
      status: skipped.result.status < 300 && Number(afterSkip.rows?.[0]?.n ?? 0) === 2 ? "pass" : "fail",
      detail: `${Number(afterSkip.rows?.[0]?.n ?? -1)} users on the target; the shared human is now missing from customer B`,
      measurements: { on_target: Number(afterSkip.rows?.[0]?.n ?? -1), status: skipped.result.status },
    });

    // Workaround 2: give the second occurrence a different address. The row
    // lands and the password still works, but the address the human types has
    // changed, which is a product decision, not a migration detail.
    const rewritten = await copyTable(
      ctx,
      srcB,
      shared,
      "auth",
      "users",
      `email = '${DUP}'`,
      { email: `replace("email", '@', '+tenant-b@')` },
    );
    const anon = (await keys(ctx, shared)).anon ?? "";
    const rewrittenEmail = DUP.replace("@", "+tenant-b@");
    const l = await login(`${shared}.supabase.co`, anon, rewrittenEmail);
    results.push({
      id: "C02f",
      title: "Rewriting the address admits the row, and the original password still works",
      status: rewritten.result.status < 300 && typeof l.json.access_token === "string" ? "pass" : "fail",
      detail:
        rewritten.result.status < 300
          ? `landed as ${rewrittenEmail}, login HTTP ${l.status} - the human's login string changed`
          : `still refused: ${sqlstate(rewritten.result)} ${rewritten.result.error?.slice(0, 120)}`,
      measurements: { insert_status: rewritten.result.status, login_status: l.status },
    });

    // Is the constraint case-sensitive? A signup normalises the address; a SQL
    // copy does not, so this decides whether a merge can silently land two
    // rows for one human.
    const upper = await copyTable(
      ctx,
      srcA,
      shared,
      "auth",
      "users",
      `email = '${DUP}'`,
      { email: `upper("email")`, id: `gen_random_uuid()` },
    );
    const variants = await sql(
      ctx,
      shared,
      `select count(*)::int as n from auth.users where lower(email) = lower('${DUP}')`,
    );
    const n = Number(variants.rows?.[0]?.n ?? -1);
    // Assert on the resulting ROW COUNT, not on the status alone: a leftover
    // upper-case row from a previous run would also produce a 23505 here, and
    // reading that as "the constraint is case-insensitive" is exactly the
    // wrong conclusion to draw from the right error code. (It happened: the
    // cleanup above used a case-sensitive LIKE and missed its own artefact.)
    const caseInsensitive = upper.result.status >= 400 && n === 1;
    results.push({
      id: "C02g",
      title: "Case-variant of the same address",
      status: caseInsensitive ? "pass" : "fail",
      detail: caseInsensitive
        ? `refused (${sqlstate(upper.result)}) with ${n} row for that human - the constraint is case-insensitive`
        : `${upper.result.status < 300 ? "ACCEPTED" : `refused ${sqlstate(upper.result)}`}: ${n} rows now differ only by case, and a SQL merge will not notice`,
      measurements: {
        status: upper.result.status,
        sqlstate: sqlstate(upper.result),
        rows_for_that_human: n,
      },
      evidence: upper.result.error?.slice(0, 300),
    });

    // If the case-variant landed, the operational question is what GoTrue then
    // does with a login for that address - one of the two rows, or neither.
    if (!caseInsensitive) {
      const rows = await sql(
        ctx,
        shared,
        `select id::text, email from auth.users where lower(email) = lower('${DUP}') order by email`,
      );
      // Repeated, because the first two runs of this experiment disagreed:
      // one reached two distinct accounts, the next reached one. A single
      // observation of either cannot tell "the login is case-insensitive and
      // always lands on the same row" apart from "which row you get is not
      // stable", and those are very different things to tell someone planning
      // a merge.
      const subOf = (r: Awaited<ReturnType<typeof login>>) => {
        const t = r.json.access_token;
        return typeof t === "string" ? String(claims(t).sub ?? "") : "";
      };
      const lowerSubs: string[] = [];
      const upperSubs: string[] = [];
      let statusLower = 0;
      let statusUpper = 0;
      for (let i = 0; i < 5; i++) {
        const lo = await login(`${shared}.supabase.co`, anon, DUP);
        const up = await login(`${shared}.supabase.co`, anon, DUP.toUpperCase());
        statusLower = lo.status;
        statusUpper = up.status;
        lowerSubs.push(subOf(lo));
        upperSubs.push(subOf(up));
      }
      const uniq = (a: string[]) => new Set(a.filter(Boolean)).size;
      const reachable = uniq([...lowerSubs, ...upperSubs]);
      const stable = uniq(lowerSubs) <= 1 && uniq(upperSubs) <= 1;
      results.push({
        id: "C02h",
        title: "Which of the two case-variant rows a login reaches, over 5 attempts",
        status: "info",
        detail: `${(rows.rows ?? []).length} rows for that human; lower HTTP ${statusLower}, upper HTTP ${statusUpper}; ${reachable} distinct account(s) reachable and the mapping was ${stable ? "stable" : "NOT stable across attempts"}`,
        measurements: {
          rows: (rows.rows ?? []).length,
          lower_status: statusLower,
          upper_status: statusUpper,
          distinct_accounts_reachable: reachable,
          distinct_for_lower_input: uniq(lowerSubs),
          distinct_for_upper_input: uniq(upperSubs),
          stable: String(stable),
        },
        evidence: `lower -> ${lowerSubs.join(",")}\nupper -> ${upperSubs.join(",")}`,
      });
    }

    return results;
  },
};
export default mod;
