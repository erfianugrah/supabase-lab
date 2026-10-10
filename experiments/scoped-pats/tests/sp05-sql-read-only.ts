/**
 * SP05 - "SQL is read-only without Database read-write" (changelog
 * scoped-personal-access-tokens-ga, 2026-10-06; doc-cited, not tested before
 * this module).
 *
 * One fixture project (PVLAB_PEER_FIXTURE, or provisioned in the Pro org),
 * and per token: `select 1` through `POST /database/query` and through
 * `POST /database/query/read-only`; then a write (`create table`) through
 * each endpoint. Whether the table exists afterwards is read back with the
 * lab token, because an HTTP status alone does not say whether the DDL ran.
 *
 *   SP05-lab  baseline. The write endpoint creates the table, the
 *                 read-only endpoint does not (this is the control that makes
 *                 the scoped rows interpretable).
 *   SP05-ro       Database = Read (PVLAB_SCOPED_PAT_RO).
 *   SP05-dbrw     Database = Read-write (PVLAB_SCOPED_PAT_DBRW).
 *
 * The probe table is dropped with the lab token after every row and again
 * in `finally`. Response bodies are not stored beyond a scrubbed 240 chars of
 * a refusal.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, denial, scrub } from "../lib/http.js";
import { isSkip, withFixture } from "../lib/fixture.js";
import { roleOf, skipReason, tokenFor } from "../lib/tokens.js";

const TABLE = "public.sp05_probe";
const q = (token: string, ref: string, endpoint: "query" | "query/read-only", sql: string) =>
  call(token, "POST", `/projects/${ref}/database/${endpoint}`, { query: sql });

async function exists(pat: string, ref: string): Promise<number | "unknown"> {
  const r = await q(pat, ref, "query", `select to_regclass('${TABLE}') is not null as present`);
  const row = Array.isArray(r.json) ? (r.json[0] as { present?: boolean } | undefined) : undefined;
  return row?.present === undefined ? "unknown" : row.present ? 1 : 0;
}

const mod: TestModule = {
  id: "SP05",
  title: "SQL endpoint with read vs read-write Database permission",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const pat = ctx.pat ?? "";
    const tokens: Array<{ name: string; token: string }> = [{ name: "lab", token: pat }];
    const results: TestResult[] = [];
    for (const n of ["ro", "dbrw"]) {
      const r = roleOf(n);
      if (tokenFor(r)) tokens.push({ name: n, token: tokenFor(r) });
      else results.push({ id: `SP05-${n}`, title: `SP05-${n}`, status: "skip", detail: skipReason(r) });
    }

    const res = await withFixture(ctx, async (ref) => {
      const out: TestResult[] = [];
      try {
        for (const t of tokens) {
          const selRw = await q(t.token, ref, "query", "select 1 as one");
          const selRo = await q(t.token, ref, "query/read-only", "select 1 as one");
          const wRo = await q(t.token, ref, "query/read-only", `create table ${TABLE}(id int)`);
          const afterRo = await exists(pat, ref);
          await q(pat, ref, "query", `drop table if exists ${TABLE}`);
          const wRw = await q(t.token, ref, "query", `create table ${TABLE}(id int)`);
          const afterRw = await exists(pat, ref);
          await q(pat, ref, "query", `drop table if exists ${TABLE}`);
          const d = denial(wRw);
          out.push({
            id: `SP05-${t.name}`,
            title: `SP05-${t.name}: select and create table through both SQL endpoints`,
            status:
              t.name === "lab"
                ? selRw.status < 300 && afterRw === 1 && afterRo === 0
                  ? "pass"
                  : "fail"
                : "info",
            detail:
              t.name === "lab"
                ? "baseline: write endpoint creates the table, read-only endpoint does not"
                : `write via /query: HTTP ${wRw.status} ${d.denied ? `missing ${d.missing.join(",")}` : scrub(wRw.text)}`,
            measurements: {
              select_query_status: selRw.status,
              select_readonly_status: selRo.status,
              create_via_readonly_endpoint_status: wRo.status,
              table_present_after_readonly_endpoint: afterRo,
              create_via_query_status: wRw.status,
              table_present_after_query_endpoint: afterRw,
            },
            evidence: `readonly-endpoint create: ${scrub(wRo.text)}\nquery-endpoint create: ${scrub(wRw.text)}`,
          });
        }
      } finally {
        await q(pat, ref, "query", `drop table if exists ${TABLE}`).catch(() => null);
      }
      return out;
    });
    if (isSkip(res)) return [{ id: "SP05-lab", title: "SP05-lab", status: "skip", detail: res.skip }, ...results];
    return [...res, ...results];
  },
};
export default mod;
