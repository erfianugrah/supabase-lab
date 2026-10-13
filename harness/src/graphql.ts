/**
 * What `/graphql/v1` is actually saying (work-supabase-lab#129).
 *
 * pg_graphql is not enabled on new projects and its introspection is off by
 * default from 1.6.0 (changelog 42180 / 46320; data-api-defaults DD02). On a
 * project without it, `/graphql/v1` still answers HTTP 200, with an errors
 * envelope ("pg_graphql extension is not enabled."), so a status code alone
 * reads "GraphQL up" on a project that has no GraphQL. DD02e measured the fix
 * iap-lockdown uses: POST `{ __typename }` (it needs no introspection) and read
 * the body. A served query is `200 ok:Query`; anything else carries the first
 * error message or the PostgREST code (`406 PGRST106` when `graphql_public` is
 * not in the exposed schemas).
 */
import { sql } from "./platform";
import type { Ctx } from "./types";

export const GRAPHQL_TYPENAME_QUERY = "{ __typename }";

/** "<status> <what the body says>", e.g. `200 ok:Query`, `200 pg_graphql extension is not enabled.`, `406 PGRST106`. */
export function graphqlState(status: number, body: string): string {
  let said = "";
  try {
    const j = JSON.parse(body) as {
      data?: { __typename?: unknown } | null;
      errors?: { message?: unknown }[];
      code?: unknown;
      message?: unknown;
    } | null;
    if (j && typeof j.data?.__typename === "string") said = `ok:${j.data.__typename}`;
    else if (j && Array.isArray(j.errors) && j.errors.length > 0) said = String(j.errors[0]?.message ?? "error");
    else if (j && j.code !== undefined && j.code !== null) said = String(j.code);
    else if (j && j.message !== undefined && j.message !== null) said = String(j.message);
  } catch {
    said = body.trim().slice(0, 60);
  }
  return said ? `${status} ${said.slice(0, 80)}` : String(status);
}

/** Whether pg_graphql is installed, via the Management query endpoint; null when the read failed. */
export async function pgGraphqlInstalled(ctx: Ctx): Promise<boolean | null> {
  const r = await sql(ctx, "select count(*)::int as n from pg_extension where extname = 'pg_graphql'");
  if (r.status !== 201 || !r.rows[0]) return null;
  return Number(r.rows[0].n ?? 0) > 0;
}
