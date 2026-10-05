/**
 * psql over the transaction pooler, running one statement batch as a given
 * user. Same shape as pdf-corpus-graph/lib/pg.ts (a lib/ file because the
 * registry scans tests/), with one addition: `asUser` wraps the statement in
 * BEGIN ... ROLLBACK with `set local role` and the request.jwt.claims GUC, the
 * way PostgREST does per request, so a write in a probe never persists.
 *
 * Everything goes in ONE -c: a single simple-query string is one round trip on
 * one pooled backend, which is what keeps SET LOCAL and the claims GUC in the
 * same transaction as the statement under test. -q suppresses the BEGIN / SET
 * / ROLLBACK status tags; set_config still prints its value as a row, so the
 * statement's result is the LAST line (rls-wire-claims C01 measured the same
 * per-transaction rule on port 6543).
 */
import { $ } from "bun";
import type { Ctx } from "../../../harness/src/types";

export function poolerUrl(ctx: Ctx): string {
  const host = ctx.endpoints.pooler;
  if (!host) throw new Error("no pooler host - set PVLAB_ENDPOINT_POOLER");
  return `postgresql://postgres.${ctx.ref}:${encodeURIComponent(ctx.dbPassword)}@${host}:6543/postgres?connect_timeout=15`;
}

export interface Outcome {
  ok: boolean;
  /** Last non-empty output line on success; the error text on failure. */
  value: string;
}

async function psql(ctx: Ctx, sqlText: string): Promise<Outcome> {
  const p = await $`psql ${poolerUrl(ctx)} -qAt -v ON_ERROR_STOP=1 -c ${sqlText}`.quiet().nothrow();
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0) return { ok: false, value: err || out };
  return { ok: true, value: out.split("\n").filter(Boolean).pop() ?? "" };
}

/** Run as postgres (owner) - for fixtures and lookups. */
export function asOwner(ctx: Ctx, sqlText: string): Promise<Outcome> {
  return psql(ctx, sqlText);
}

/** Run as `authenticated` with the given user id, or as `anon` when null. */
export function asUser(ctx: Ctx, sub: string | null, sqlText: string): Promise<Outcome> {
  const claims = sub === null ? "" : JSON.stringify({ sub, role: "authenticated" }).replaceAll("'", "''");
  const prelude =
    sub === null
      ? "begin; set local role anon;"
      : `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims}', true);`;
  return psql(ctx, `${prelude} ${sqlText}; rollback;`);
}
