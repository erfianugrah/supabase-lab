/**
 * DD02 - pg_graphql on a new project: absent by default, enabled on request,
 * introspection refused by default, opt-in through a schema comment.
 *
 * Source claims (public notices, github.com/orgs/supabase/discussions/42180 and
 * /46320): pg_graphql is disabled by default on new projects (42180, announced
 * 2026-01-26); from pg_graphql 1.6.0 introspection is off by default for projects created on or
 * after 2026-06-29 and
 *   comment on schema public is e'@graphql({"introspection": true})';
 * opts a schema in. `{ __schema }` then answers `Unknown field "__schema" on
 * type Query` instead of data.
 *
 *   DD02a  pg_graphql absent on the fresh project: pg_extension, the default
 *          version on offer, and what POST /graphql/v1 answers for
 *          `{ __typename }` and the OLD iap-lockdown probe `{ __schema ... }`.
 *   DD02b  CREATE EXTENSION pg_graphql: installed version, seconds until the
 *          endpoint serves `{ __typename }`.
 *   DD02c  enabled, no opt-in: `__schema` and `__type` refused, `__typename`
 *          and a real collection query served.
 *   DD02d  comment-on-schema opt-in: `__schema` / `__type` served; setting
 *          `"introspection": false` refuses them again.
 *   DD02e  the FIXED iap-lockdown probe (lib/inventory.ts http() with
 *          GRAPHQL_PROBE_QUERY) in each state: its status/code differ where the
 *          old `{ __schema }` probe reads 200 in every state.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { GRAPHQL_PROBE_QUERY, http } from "../../iap-lockdown/lib/inventory.js";
import { skipWithoutPro, brief, currentProject, dataApi, ensureProject, pollApi, sql, type DdProject } from "../lib/project.js";

const OLD_PROBE = "{ __schema { queryType { name } } }";
const TYPE_PROBE = '{ __type(name: "Query") { name } }';

const gql = (p: DdProject, key: string, query: string) =>
  dataApi(p.host, "/graphql/v1", key, { method: "POST", body: { query } });

/** Error messages of a GraphQL envelope (the raw body escapes the quotes inside them). */
const messages = (r: { json?: unknown }): string =>
  (((r.json ?? {}) as { errors?: { message?: string }[] }).errors ?? []).map((e) => e.message ?? "").join(" | ");

function summary(r: { status: number; json?: unknown }): string {
  const j = (r.json ?? {}) as { data?: Record<string, unknown> | null; errors?: { message?: string }[] };
  const err = j.errors?.[0]?.message;
  if (err) return `${r.status} errors:${err}`.slice(0, 120);
  return `${r.status} data:${JSON.stringify(j.data ?? null).slice(0, 80)}`;
}

const mod: TestModule = {
  id: "DD02",
  title: "pg_graphql default state, introspection default and opt-in",
  where: "local",
  requires: ["pat", "org"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const skip = skipWithoutPro(ctx, "DD02");
    if (skip) return skip;
    let p: DdProject;
    try {
      p = await ensureProject(ctx);
    } catch (e) {
      return [{ id: "DD02", title: "DD02", status: "fail", detail: `provision: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const url = `https://${p.host}/graphql/v1`;
    const fixedProbe = async () => {
      const r = await http(url, { method: "POST", key: p.keys.anon, body: { query: GRAPHQL_PROBE_QUERY } });
      return `${r.status} ${r.code}`;
    };
    const oldProbe = async () => {
      const r = await http(url, { method: "POST", key: p.keys.anon, body: { query: OLD_PROBE } });
      return `${r.status} ${r.code}`;
    };
    try {
      const orig = await sql(ctx, p.ref, "select obj_description('public'::regnamespace) as c");
      const origComment = orig.rows?.[0]?.c == null ? null : String(orig.rows[0].c);
      // ---- DD02a: absent ----
      const ext = await sql(ctx, p.ref, "select extname from pg_extension where extname = 'pg_graphql'");
      const avail = await sql(ctx, p.ref, "select default_version, installed_version from pg_available_extensions where name = 'pg_graphql'");
      const fn = await sql(ctx, p.ref, "select count(*)::int as n from pg_proc where proname = 'graphql' and pronamespace = 'graphql_public'::regnamespace");
      const typename0 = await gql(p, p.keys.anon, "{ __typename }");
      const schema0 = await gql(p, p.keys.anon, OLD_PROBE);
      const fixed0 = await fixedProbe();
      const old0 = await oldProbe();
      results.push({
        id: "DD02a",
        title: "DD02a: pg_graphql absent on a fresh API-created project",
        status: (ext.rows ?? []).length === 0 ? "pass" : "fail",
        detail: `typename -> ${summary(typename0)}`,
        measurements: {
          installed_rows: (ext.rows ?? []).length,
          default_version_offered: String(avail.rows?.[0]?.default_version ?? "absent"),
          graphql_public_graphql_fn: Number(fn.rows?.[0]?.n ?? -1),
          typename_answer: summary(typename0),
          old_probe_answer: summary(schema0),
          fixed_probe_row: fixed0,
          old_probe_row: old0,
        },
      });

      // ---- DD02b: enable ----
      const t0 = Date.now();
      const create = await sql(ctx, p.ref, "create extension pg_graphql");
      const ver = await sql(ctx, p.ref, "select extversion from pg_extension where extname = 'pg_graphql'");
      // A real table first, so the schema has something to serve; anon may read it.
      await sql(ctx, p.ref, `create table public.dd02_g (id int primary key, note text);
        grant select on public.dd02_g to anon;
        insert into public.dd02_g values (1, 'row');`);
      const served = await pollApi(
        () => gql(p, p.keys.anon, "{ __typename }"),
        (r) => ((r.json as { data?: { __typename?: string } } | undefined)?.data?.__typename ?? "") === "Query",
        60_000,
      );
      results.push({
        id: "DD02b",
        title: "DD02b: CREATE EXTENSION pg_graphql, time until the endpoint serves",
        status: create.status < 300 && served.ok ? "pass" : "fail",
        detail: create.status < 300 ? `serving after ${served.s}s` : `create HTTP ${create.status}: ${create.error ?? ""}`,
        measurements: {
          create_status: create.status,
          extversion: String(ver.rows?.[0]?.extversion ?? "absent"),
          seconds_to_serve_typename: served.s,
          total_ms: Date.now() - t0,
        },
      });

      // ---- DD02c: enabled, no opt-in ----
      const schema1 = await gql(p, p.keys.anon, OLD_PROBE);
      const type1 = await gql(p, p.keys.anon, TYPE_PROBE);
      const typename1 = await gql(p, p.keys.anon, "{ __typename }");
      const coll = await pollApi(
        () => gql(p, p.keys.anon, "{ dd02_gCollection { edges { node { id note } } } }"),
        (r) => !!(r.json as { data?: { dd02_gCollection?: unknown } } | undefined)?.data?.dd02_gCollection,
        30_000,
      );
      const comment1 = await sql(ctx, p.ref, "select obj_description('public'::regnamespace) as c");
      const fixed1 = await fixedProbe();
      const old1 = await oldProbe();
      const refused = /Unknown field "__schema"/.test(messages(schema1)) && /Unknown field "__type"/.test(messages(type1));
      results.push({
        id: "DD02c",
        title: "DD02c: introspection refused by default once pg_graphql is on",
        status: refused && typename1.status === 200 ? "pass" : "fail",
        detail: `__schema -> ${summary(schema1)}; __type -> ${summary(type1)}`,
        measurements: {
          schema_answer: summary(schema1),
          type_answer: summary(type1),
          typename_answer: summary(typename1),
          collection_answer: summary(coll.last),
          public_schema_comment: String(comment1.rows?.[0]?.c ?? "null"),
          fixed_probe_row: fixed1,
          old_probe_row: old1,
        },
      });

      // ---- DD02d: opt-in via schema comment, then explicit false ----
      await sql(ctx, p.ref, `comment on schema public is e'@graphql({"introspection": true})'`);
      const on = await pollApi(
        () => gql(p, p.keys.anon, OLD_PROBE),
        (r) => !!(r.json as { data?: { __schema?: unknown } } | undefined)?.data?.__schema,
        60_000,
      );
      const typeOn = await gql(p, p.keys.anon, TYPE_PROBE);
      const fixed2 = await fixedProbe();
      const old2 = await oldProbe();
      await sql(ctx, p.ref, `comment on schema public is e'@graphql({"introspection": false})'`);
      const off = await pollApi(
        () => gql(p, p.keys.anon, OLD_PROBE),
        (r) => /Unknown field "__schema"/.test(messages(r)),
        60_000,
      );
      results.push({
        id: "DD02d",
        title: "DD02d: comment-on-schema introspection opt-in, and explicit false",
        status: on.ok && off.ok ? "pass" : "fail",
        detail: `opt-in: __schema -> ${summary(on.last)}; false: ${summary(off.last)}`,
        measurements: {
          optin_schema_answer: summary(on.last),
          optin_type_answer: summary(typeOn),
          optin_seconds_to_serve: on.s,
          explicit_false_schema_answer: summary(off.last),
          explicit_false_seconds_to_refuse: off.s,
          fixed_probe_row_optin: fixed2,
          old_probe_row_optin: old2,
        },
      });

      // Put the schema comment back: PostgREST serves it as the OpenAPI spec title (DD04).
      await sql(ctx, p.ref, `comment on schema public is ${origComment === null ? "null" : `$dd$${origComment}$dd$`}`);

      // ---- DD02e: the fixed probe against the three states ----
      results.push({
        id: "DD02e",
        title: "DD02e: fixed vs old iap-lockdown GraphQL probe across the states",
        status: fixed0 !== fixed1 && old0.startsWith("200") && old1.startsWith("200") ? "pass" : "fail",
        detail: `absent: fixed=[${fixed0}] old=[${old0}]; on, no opt-in: fixed=[${fixed1}] old=[${old1}]; opt-in: fixed=[${fixed2}] old=[${old2}]`,
        measurements: {
          absent_fixed: fixed0,
          absent_old: old0,
          enabled_fixed: fixed1,
          enabled_old: old1,
          optin_fixed: fixed2,
          optin_old: old2,
        },
        evidence: brief(currentProject(), `${fixed0} | ${fixed1} | ${fixed2}`, 300),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: "DD02", title: "DD02", status: "fail", detail: `test threw: ${msg}` });
    }
    return results;
  },
};
export default mod;
