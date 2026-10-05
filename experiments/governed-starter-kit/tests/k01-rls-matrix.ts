/**
 * K01 - the kit's guardrails, as a matrix of who can do what.
 *
 * Runs against the `ready` project (kit baseline + example app + agent schema,
 * seeded by `make seed-ready`): two departments, an employee and a manager in
 * each. Every probe runs as that user through `set local role` + the claims
 * GUC inside a rolled-back transaction, so nothing persists.
 *
 * A row passes when the observed outcome matches the expected one. A probe
 * that errors where it should succeed is a failure of the kit; one that
 * succeeds where it should be refused is a hole.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { asOwner, asUser, type Outcome } from "../lib/pg";

interface Probe {
  name: string;
  as: "alice" | "bob" | "carol" | "dave" | "anon";
  sql: (ids: Ids) => string;
  /** "ok" = must succeed (optionally with this exact value); "denied" = must error. */
  expect: { ok: true; value?: string } | { ok: false };
}

interface Ids {
  users: Record<string, string>;
  aliceRequest: string;
  carolRequest: string;
}

const EMAILS = {
  alice: "alice@example.com",
  bob: "bob@example.com",
  carol: "carol@example.com",
  dave: "dave@example.com",
};

const PROBES: Probe[] = [
  {
    name: "employee sees only own department's requests",
    as: "alice",
    sql: () =>
      "select count(*) from public.purchase_requests where department_id <> (select department_id from public.profiles where id = auth.uid())",
    expect: { ok: true, value: "0" },
  },
  {
    name: "other department's employee cannot see the request",
    as: "carol",
    sql: (i) => `select count(*) from public.purchase_requests where id = '${i.aliceRequest}'`,
    expect: { ok: true, value: "0" },
  },
  {
    name: "employee cannot promote themselves (column grant)",
    as: "alice",
    sql: () => "update public.profiles set role = 'manager' where id = auth.uid()",
    expect: { ok: false },
  },
  {
    name: "employee cannot move department (column grant)",
    as: "alice",
    sql: () => "update public.profiles set department_id = gen_random_uuid() where id = auth.uid()",
    expect: { ok: false },
  },
  {
    name: "employee cannot approve",
    as: "alice",
    sql: (i) => `select (public.decide_purchase_request('${i.aliceRequest}', 'approved')).status`,
    expect: { ok: false },
  },
  {
    name: "manager approves in own department",
    as: "bob",
    sql: (i) => `select (public.decide_purchase_request('${i.aliceRequest}', 'approved')).status`,
    expect: { ok: true, value: "approved" },
  },
  {
    name: "manager cannot approve another department",
    as: "bob",
    sql: (i) => `select (public.decide_purchase_request('${i.carolRequest}', 'approved')).status`,
    expect: { ok: false },
  },
  {
    name: "employee submits a request; department and requester come from the session",
    as: "carol",
    sql: () =>
      "insert into public.purchase_requests (item, vendor, amount, justification) values ('probe', 'probe', 1, 'probe') returning (department_id = (select department_id from public.profiles where id = auth.uid()) and requester_id = auth.uid())::text",
    expect: { ok: true, value: "true" },
  },
  {
    name: "employee cannot submit with a forged status",
    as: "carol",
    sql: () =>
      "insert into public.purchase_requests (item, vendor, amount, justification, status) values ('probe', 'probe', 1, 'probe', 'approved')",
    expect: { ok: false },
  },
  {
    name: "knowledge base: company-wide plus own department only",
    as: "carol",
    sql: () =>
      "select count(*) from public.kb_chunks where department_id is not null and department_id <> (select department_id from public.profiles where id = auth.uid())",
    expect: { ok: true, value: "0" },
  },
  {
    name: "vector match only returns rows the user can read",
    as: "carol",
    sql: () =>
      "select count(*) from public.match_kb_chunks((select embedding from public.kb_chunks limit 1), 20) m join public.kb_chunks k on k.id = m.id where k.department_id is not null and k.department_id <> (select department_id from public.profiles where id = auth.uid())",
    expect: { ok: true, value: "0" },
  },
  {
    name: "anon has no table access",
    as: "anon",
    sql: () => "select count(*) from public.purchase_requests",
    expect: { ok: false },
  },
  {
    name: "anon cannot call the decision function",
    as: "anon",
    sql: (i) => `select public.decide_purchase_request('${i.aliceRequest}', 'approved')`,
    expect: { ok: false },
  },
];

async function lookupIds(ctx: Ctx): Promise<Ids | string> {
  const users: Record<string, string> = {};
  for (const [who, email] of Object.entries(EMAILS)) {
    const r = await asOwner(ctx, `select id from auth.users where email = '${email}'`);
    if (!r.ok || !r.value) return `user ${email} not found - run make seed-ready (${r.value.slice(0, 200)})`;
    users[who] = r.value;
  }
  const req = async (email: string): Promise<Outcome> =>
    asOwner(
      ctx,
      `select r.id from public.purchase_requests r join auth.users u on u.id = r.requester_id where u.email = '${email}' and r.status = 'pending' order by r.created_at limit 1`,
    );
  const a = await req(EMAILS.alice);
  const c = await req(EMAILS.carol);
  if (!a.ok || !a.value || !c.ok || !c.value) return "seeded requests not found - run make seed-ready";
  return { users, aliceRequest: a.value, carolRequest: c.value };
}

const mod: TestModule = {
  id: "K01",
  title: "starter-kit RLS matrix (two departments x employee/manager, plus anon)",
  where: "local",
  requires: ["pooler"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const ids = await lookupIds(ctx);
    if (typeof ids === "string") return [{ id: "K01", title: this.title, status: "fail", detail: ids }];

    const results: TestResult[] = [];
    let n = 0;
    for (const p of PROBES) {
      n++;
      const sub = p.as === "anon" ? null : (ids.users[p.as] ?? null);
      const got = await asUser(ctx, sub, p.sql(ids));
      const pass = p.expect.ok
        ? got.ok && (p.expect.value === undefined || got.value === p.expect.value)
        : !got.ok;
      results.push({
        id: `K01.${String(n).padStart(2, "0")}`,
        title: `${p.as}: ${p.name}`,
        status: pass ? "pass" : "fail",
        detail: pass
          ? p.expect.ok
            ? `allowed${got.value ? ` (${got.value})` : ""}`
            : "refused"
          : `expected ${p.expect.ok ? "success" : "refusal"}, got ${got.ok ? "success" : "error"}`,
        evidence: got.value.slice(0, 500),
      });
    }
    return results;
  },
};

export default mod;
