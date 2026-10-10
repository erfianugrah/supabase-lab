/**
 * RT01 - Postgres Changes filter composition, operators and column select,
 * on one throwaway Pro project, from the local vantage with the current
 * supabase-js (the blog names a minimum version for `select`; the installed
 * version is recorded in RT01a).
 *
 * The docs claim (https://supabase.com/blog/postgres-changes-filters-and-column-selection):
 * comma = AND across columns; operators like / ilike / is / match / imatch /
 * isdistinct and a `not.` prefix; `select` trims the payload and always keeps
 * the primary key; DELETE events carry only the primary key so a column
 * filter cannot be evaluated; the selected columns must be selectable by the
 * subscribing role; filtered events reduce the per-subscriber message count.
 *
 *   RT01a        setup facts: client version, publication, replica identity
 *   RT01b-<case> one subscription per filter on the same 8-row batch; the
 *                ids received are compared with `select id ... where <SQL
 *                predicate>` run on the same rows (the oracle is Postgres's
 *                own evaluation of the equivalent predicate, not a reimplementation)
 *   RT01c        `select` option: record keys on INSERT / UPDATE / DELETE,
 *                PK injection, an UPDATE that touches only an unselected
 *                column, a nonexistent column
 *   RT01d        DELETE under a filter (replica identity default, then FULL),
 *                and an UPDATE that moves a row out of / into a filter
 *   RT01e        select naming a column revoked from the subscribing role
 *                (authenticated), no-select payload for that role, anon control
 *   RT01f        delivered events per subscriber with vs without a filter;
 *                usage.api-counts read before/after (the org usage endpoint
 *                that carries billed message counts refuses a PAT, see I10)
 *
 * DESTRUCTIVE: creates and deletes a project.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import {
  anonClient,
  ddl,
  errText,
  makeUser,
  mg,
  newState,
  rows,
  sleep,
  subscribeAndWait,
  userClient,
  waitCdc,
  withProject,
  skipWithoutOrg,
  type Proj,
  type SubState,
} from "../lib/rt";

const T = "rt01_t";

interface PgCfg {
  event?: "*" | "INSERT" | "UPDATE" | "DELETE";
  filter?: string;
  select?: string[];
}

async function pgSub(c: SupabaseClient, name: string, cfg: PgCfg): Promise<SubState & { ch: ReturnType<SupabaseClient["channel"]> }> {
  const st = newState();
  const ch = c.channel(name);
  (ch as any).on("system", {}, (m: unknown) => st.system.push(JSON.stringify(m).slice(0, 700)));
  (ch as any).on(
    "postgres_changes",
    { event: cfg.event ?? "*", schema: "public", table: T, ...(cfg.filter ? { filter: cfg.filter } : {}), ...(cfg.select ? { select: cfg.select } : {}) },
    (p: Record<string, any>) => st.events.push(p),
  );
  await subscribeAndWait(ch, st);
  return Object.assign(st, { ch });
}

const batchSql = `insert into public.${T} (n, team, status, email, flag, note, secret) values
  (1,'a','open','Alice@example.com',true,null,'s'),
  (2,'a','closed','bob@example.com',false,'x','s'),
  (3,'b','open','carol@example.org',null,'x','s'),
  (4,'b','closed','dave@example.com',true,null,'s'),
  (5,'a','open','eve@example.com',false,'active','s'),
  (6,'c',null,'Frank@example.com',null,'active','s'),
  (7,'a','archived','ann@example.com',true,'y','s'),
  (8,'b','open',null,false,'y','s')
  returning id, n`;

/** filter string (as passed to supabase-js) and the SQL predicate that is its Postgres equivalent. */
const CASES: Array<{ name: string; filter: string; pred: string }> = [
  { name: "eq", filter: "team=eq.a", pred: "team = 'a'" },
  { name: "and2", filter: "team=eq.a,status=eq.open", pred: "team = 'a' and status = 'open'" },
  { name: "and3", filter: "team=eq.a,status=eq.open,flag=eq.true", pred: "team = 'a' and status = 'open' and flag = true" },
  { name: "and_range", filter: "n=gt.2,n=lt.6", pred: "n > 2 and n < 6" },
  { name: "in", filter: "team=in.(a,c)", pred: "team in ('a','c')" },
  { name: "like", filter: "email=like.a%", pred: "email like 'a%'" },
  { name: "ilike", filter: "email=ilike.a%", pred: "email ilike 'a%'" },
  { name: "is_null", filter: "note=is.null", pred: "note is null" },
  { name: "is_true", filter: "flag=is.true", pred: "flag is true" },
  { name: "is_false", filter: "flag=is.false", pred: "flag is false" },
  { name: "match", filter: "email=match.^[a-d]", pred: "email ~ '^[a-d]'" },
  { name: "imatch", filter: "email=imatch.^[a-d]", pred: "email ~* '^[a-d]'" },
  { name: "isdistinct", filter: "note=isdistinct.active", pred: "note is distinct from 'active'" },
  { name: "not_eq", filter: "status=not.eq.open", pred: "not (status = 'open')" },
  { name: "not_like", filter: "email=not.like.a%", pred: "not (email like 'a%')" },
  { name: "not_in", filter: "team=not.in.(a,b)", pred: "not (team in ('a','b'))" },
  { name: "not_is_null", filter: "note=not.is.null", pred: "note is not null" },
  { name: "and_not", filter: "team=eq.a,status=not.eq.open", pred: "team = 'a' and not (status = 'open')" },
  { name: "and_like_is", filter: "email=ilike.a%,flag=is.true", pred: "email ilike 'a%' and flag is true" },
];

const keysOf = (o: unknown) => Object.keys((o as Record<string, unknown>) ?? {}).sort().join(",");

const mod: TestModule = {
  id: "RT01",
  title: "Postgres Changes: AND filters, operators, select, DELETE, revoked column, delivered counts",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const put = (r: TestResult) => out.push(r);
    const skip = skipWithoutOrg(ctx, "RT01", "RT01");
    if (skip) return skip;
    try {
      await withProject(ctx, "rt01", async (p: Proj) => {
        await ddl(
          p,
          `drop table if exists public.${T};
           create table public.${T} (id bigint generated always as identity primary key, n int, team text, status text, email text, flag boolean, note text, secret text);
           grant select on public.${T} to anon, authenticated;
           grant all on public.${T} to service_role;
           alter publication supabase_realtime add table public.${T};`,
        );
        const cdc = await waitCdc(p, T, (k) => `insert into public.${T} (n) values (${-k})`);
        const cdcMs = cdc.ms;
        await sleep(3000);
        await ddl(p, `delete from public.${T} where n < 0`);
        await sleep(3000);
        const pk = await rows(p, `select relreplident::text as ri from pg_class where oid = 'public.${T}'::regclass`);
        const sdkVersion = (await Bun.file(new URL("../../../node_modules/@supabase/supabase-js/package.json", import.meta.url)).json()).version as string;
        put({
          id: "RT01a",
          title: "RT01a: setup",
          status: cdcMs >= 0 ? "pass" : "fail",
          detail: `supabase-js ${sdkVersion}; first change event ${cdcMs} ms after subscribing, from canary insert ${cdc.firstDeliveredInsert} of ${cdc.inserts} (one every 10 s); ${cdc.events} canary event(s) received; replica identity ${String(pk[0]?.ri)}`,
          measurements: { first_change_event_ms: cdcMs, canary_inserts: cdc.inserts, first_delivered_canary: cdc.firstDeliveredInsert, canary_events: cdc.events, replica_identity: String(pk[0]?.ri), supabase_js: sdkVersion },
        });

        const c = anonClient(p);

        /* ---------- RT01b: operators ---------- */
        {
          const base = await pgSub(c, "rt01-base", {});
          const subs = new Map<string, Awaited<ReturnType<typeof pgSub>>>();
          for (const k of CASES) subs.set(k.name, await pgSub(c, `rt01-${k.name}`, { event: "INSERT", filter: k.filter }));
          const ins = await rows(p, batchSql);
          const batchIds = ins.map((r) => Number(r.id));
          const t0 = Date.now();
          const inBatch = (e: Record<string, any>) => batchIds.includes(Number(e.new?.id));
          while (Date.now() - t0 < 20_000 && base.events.filter(inBatch).length < 8) await sleep(250);
          await sleep(4000);
          for (const k of CASES) {
            const s = subs.get(k.name)!;
            const got = s.events.filter(inBatch).map((e) => Number(e.new?.id)).sort((a, b) => a - b);
            const exp = (await rows(p, `select id from public.${T} where id = any(array[${batchIds.join(",")}]) and (${k.pred}) order by id`)).map((r) => Number(r.id));
            const match = JSON.stringify(got) === JSON.stringify(exp);
            put({
              id: `RT01b-${k.name}`,
              title: `RT01b-${k.name}: filter ${k.filter}`,
              status: s.status !== "SUBSCRIBED" ? "fail" : match ? "pass" : "fail",
              detail: s.status !== "SUBSCRIBED" ? `subscribe ${s.status}: ${s.err}` : `got ${got.length} of batch 8, SQL oracle ${exp.length}; ${match ? "same ids" : `got [${got}] oracle [${exp}]`}`,
              measurements: { subscribe: s.status, got: got.length, oracle: exp.length, same_ids: match ? 1 : 0 },
              evidence: [s.err, ...s.system].filter(Boolean).join(" | ") || undefined,
            });
          }
          put({
            id: "RT01b-base",
            title: "RT01b-base: unfiltered subscriber receives the whole batch",
            status: base.events.filter(inBatch).length === 8 ? "pass" : "fail",
            detail: `${base.events.filter(inBatch).length} of the 8 batch rows; ${base.events.length - base.events.filter(inBatch).length} other event(s) (late canary rows)`,
            measurements: { subscribe: base.status, got: base.events.filter(inBatch).length, other_events: base.events.length - base.events.filter(inBatch).length },
          });
          await c.removeAllChannels();
        }

        /* ---------- RT01c: select ---------- */
        {
          const cases: Array<{ name: string; select: string[] }> = [
            { name: "status", select: ["status"] },
            { name: "id_team", select: ["id", "team"] },
            { name: "status_email", select: ["status", "email"] },
            { name: "nonexistent", select: ["nope"] },
          ];
          const none = await pgSub(c, "rt01c-none", {});
          const subs = new Map<string, Awaited<ReturnType<typeof pgSub>>>();
          for (const k of cases) subs.set(k.name, await pgSub(c, `rt01c-${k.name}`, { select: k.select }));
          const r1 = await rows(p, `insert into public.${T} (n, team, status, email, note, secret) values (101,'a','open','sel@example.com','n0','s') returning id`);
          const id = Number(r1[0]?.id);
          await sleep(2500);
          await rows(p, `update public.${T} set note = 'n1' where id = ${id}`); // unselected-column-only update (for status/id_team)
          await sleep(2500);
          await rows(p, `update public.${T} set status = 'closed' where id = ${id}`);
          await sleep(2500);
          await rows(p, `delete from public.${T} where id = ${id}`);
          await sleep(4000);
          const summarise = (s: SubState) => s.events.map((e) => `${e.eventType}:new[${keysOf(e.new)}]old[${keysOf(e.old)}]`).join(" | ");
          put({
            id: "RT01c-none",
            title: "RT01c-none: no select (control)",
            status: none.events.length === 4 ? "pass" : "info",
            detail: summarise(none),
            measurements: { subscribe: none.status, events: none.events.length },
          });
          for (const k of cases) {
            const s = subs.get(k.name)!;
            const insEv = s.events.find((e) => e.eventType === "INSERT");
            const hasPk = insEv ? Object.keys(insEv.new ?? {}).includes("id") : false;
            put({
              id: `RT01c-${k.name}`,
              title: `RT01c-${k.name}: select [${k.select.join(",")}]`,
              status: "info",
              detail: s.status === "SUBSCRIBED" ? summarise(s) || "subscribed, no events" : `subscribe ${s.status}: ${s.err}`,
              measurements: {
                subscribe: s.status,
                events: s.events.length,
                insert_keys: keysOf(insEv?.new),
                pk_in_insert: hasPk ? 1 : 0,
                update_events: s.events.filter((e) => e.eventType === "UPDATE").length,
                delete_events: s.events.filter((e) => e.eventType === "DELETE").length,
              },
              evidence: [s.err, ...s.system].filter(Boolean).join(" | ") || undefined,
            });
          }
          await c.removeAllChannels();
        }

        /* ---------- RT01d: DELETE under filter ---------- */
        for (const ident of ["default", "full"] as const) {
          if (ident === "full") await ddl(p, `alter table public.${T} replica identity full`);
          const seed = await rows(
            p,
            `insert into public.${T} (n, team, status) values (201,'a','open'),(202,'a','closed'),(203,'b','open'),(204,'b','closed') returning id, n`,
          );
          const idOf = (n: number) => Number(seed.find((r) => Number(r.n) === n)?.id);
          const f = {
            team_a: await pgSub(c, `rt01d-${ident}-a`, { event: "*", filter: "team=eq.a" }),
            and2_del: await pgSub(c, `rt01d-${ident}-and`, { event: "DELETE", filter: "team=eq.a,status=eq.open" }),
            pk_del: await pgSub(c, `rt01d-${ident}-pk`, { event: "DELETE", filter: `id=eq.${idOf(201)}` }),
            unfiltered_del: await pgSub(c, `rt01d-${ident}-none`, { event: "DELETE" }),
          };
          // UPDATE that moves a row out of, then back into, the filter
          await rows(p, `update public.${T} set team = 'b' where id = ${idOf(201)}`);
          await sleep(2500);
          await rows(p, `update public.${T} set team = 'a' where id = ${idOf(201)}`);
          await sleep(2500);
          await rows(p, `delete from public.${T} where n in (201,202,203,204)`);
          await sleep(5000);
          const delIds = (s: SubState) => s.events.filter((e) => e.eventType === "DELETE").map((e) => Number(e.old?.id)).sort((a, b) => a - b);
          const delKeys = (s: SubState) => keysOf(s.events.find((e) => e.eventType === "DELETE")?.old);
          for (const [k, s] of Object.entries(f)) {
            put({
              id: `RT01d-${ident}-${k}`,
              title: `RT01d (replica identity ${ident}): ${k}`,
              status: "info",
              detail: s.status === "SUBSCRIBED" ? `DELETE ids [${delIds(s)}] of seeded [${[201, 202, 203, 204].map(idOf)}]; UPDATE events ${s.events.filter((e) => e.eventType === "UPDATE").length} (new.team [${s.events.filter((e) => e.eventType === "UPDATE").map((e) => e.new?.team)}])` : `subscribe ${s.status}: ${s.err}`,
              measurements: {
                subscribe: s.status,
                delete_events: delIds(s).length,
                delete_old_keys: delKeys(s),
                update_events: s.events.filter((e) => e.eventType === "UPDATE").length,
              },
              evidence: [s.err, ...s.system].filter(Boolean).join(" | ") || undefined,
            });
          }
          await c.removeAllChannels();
        }
        await ddl(p, `alter table public.${T} replica identity default`);

        /* ---------- RT01e: select naming a column revoked from the role ---------- */
        {
          const u = await makeUser(p, "rt01");
          const uc = await userClient(p, u);
          await ddl(
            p,
            `revoke select on public.${T} from authenticated;
             grant select (id, n, team, status, email, flag, note) on public.${T} to authenticated;`,
          );
          // PostgREST control: the role really cannot read the column
          const pr = await uc.from(T).select("secret").limit(1);
          const pr2 = await uc.from(T).select("id,team").limit(1);
          put({
            id: "RT01e-control",
            title: "RT01e-control: PostgREST as authenticated after the column revoke",
            status: pr.error && !pr2.error ? "pass" : "fail",
            detail: `select=secret: ${pr.error ? `${pr.error.code} ${pr.error.message}` : "allowed"}; select=id,team: ${pr2.error ? pr2.error.message : "ok"}`,
          });
          const cp = await rows(p, `select has_column_privilege('authenticated','public.${T}','secret','select') as secret_priv, has_column_privilege('authenticated','public.${T}','team','select') as team_priv`);
          put({ id: "RT01e-priv", title: "RT01e-priv: has_column_privilege for authenticated", status: "info", detail: JSON.stringify(cp[0]), measurements: { secret_priv: String(cp[0]?.secret_priv), team_priv: String(cp[0]?.team_priv) } });
          const e = {
            star: await pgSub(uc, "rt01e-star", { event: "*" }),
            ok: await pgSub(uc, "rt01e-ok", { event: "*", select: ["id", "team"] }),
            secret: await pgSub(uc, "rt01e-secret", { event: "*", select: ["id", "secret"] }),
            filter_secret: await pgSub(uc, "rt01e-fsecret", { event: "*", filter: "secret=eq.s" }),
            anon_secret: await pgSub(c, "rt01e-anon-secret", { event: "*", select: ["id", "secret"] }),
          };
          const r301 = await rows(p, `insert into public.${T} (n, team, secret) values (301,'a','s1') returning id`);
          const id301 = Number(r301[0]?.id);
          await sleep(2500);
          await rows(p, `update public.${T} set note = 'touched' where id = ${id301}`); // secret not in the SET list
          await sleep(2500);
          await rows(p, `update public.${T} set secret = 's2' where id = ${id301}`); // secret in the SET list
          await sleep(2500);
          await rows(p, `delete from public.${T} where id = ${id301}`);
          await sleep(5000);
          const secretOf = (s: SubState, kind: string, nth: number) => {
            const ev = s.events.filter((x) => x.eventType === kind)[nth];
            if (!ev) return "no-event";
            return "secret" in (ev.new ?? {}) ? `present=${String(ev.new.secret)}` : "absent";
          };
          for (const [k, s] of Object.entries(e)) {
            put({
              id: `RT01e-${k}`,
              title: `RT01e-${k}`,
              status: "info",
              detail:
                s.status === "SUBSCRIBED"
                  ? s.events.map((x) => `${x.eventType}:new[${keysOf(x.new)}]`).join(" | ")
                  : `subscribe ${s.status}: ${s.err}`,
              measurements: {
                subscribe: s.status,
                events: s.events.length,
                insert_secret: secretOf(s, "INSERT", 0),
                update_note_only_secret: secretOf(s, "UPDATE", 0),
                update_secret_set_secret: secretOf(s, "UPDATE", 1),
                delete_events: s.events.filter((x) => x.eventType === "DELETE").length,
              },
              evidence: [s.statusLog.map((l) => `${l.status}${l.err ? `(${l.err})` : ""}`).join(">"), ...s.system].filter(Boolean).join(" | "),
            });
          }
          await uc.removeAllChannels();
          await c.removeAllChannels();
          await ddl(p, `grant select on public.${T} to authenticated`);
        }

        /* ---------- RT01f: delivered events with vs without a filter ---------- */
        {
          const usage = async () => {
            const r = await mg(p.ctx, "GET", `/projects/${p.ref}/analytics/endpoints/usage.api-counts?interval=15min`);
            const j = (r.json ?? {}) as { result?: Array<Record<string, unknown>>; error?: unknown };
            const res = j.result ?? [];
            const sum = (k: string) => res.reduce((a, x) => a + Number(x[k] ?? 0), 0);
            return { status: r.status, buckets: res.length, keys: Object.keys(res[0] ?? {}).join(","), realtime: sum("total_realtime_requests") };
          };
          const u0 = await usage();
          const A = await pgSub(c, "rt01f-all", { event: "INSERT" });
          const B = await pgSub(c, "rt01f-a", { event: "INSERT", filter: "team=eq.a" });
          const Cc = await pgSub(c, "rt01f-a-sel", { event: "INSERT", filter: "team=eq.a", select: ["id"] });
          const vals = Array.from({ length: 20 }, (_, i) => `(${400 + i},'${i % 2 === 0 ? "a" : "b"}','open')`).join(",");
          await rows(p, `insert into public.${T} (n, team, status) values ${vals}`);
          await sleep(8000);
          await sleep(90_000); // let the analytics bucket catch up before the second read
          const u1 = await usage();
          put({
            id: "RT01f",
            title: "RT01f: delivered events per subscriber, 20 inserts (10 team a)",
            status: A.events.length === 20 && B.events.length === 10 ? "pass" : "info",
            detail: `unfiltered ${A.events.length}, team=eq.a ${B.events.length}, team=eq.a + select [id] ${Cc.events.length}. usage.api-counts total_realtime_requests before ${u0.realtime} after ${u1.realtime} (counts requests, not messages; billed message counts are not readable with a PAT)`,
            measurements: {
              delivered_unfiltered: A.events.length,
              delivered_filtered: B.events.length,
              delivered_filtered_select: Cc.events.length,
              usage_status: u1.status,
              usage_buckets: u1.buckets,
              usage_realtime_before: u0.realtime,
              usage_realtime_after: u1.realtime,
            },
            evidence: `usage.api-counts row keys: ${u1.keys}`,
          });
          await c.removeAllChannels();
        }
      });
    } catch (e) {
      put({ id: "RT01", title: "RT01", status: "fail", detail: `module threw: ${errText(e)}` });
    }
    return out;
  },
};
export default mod;
