/**
 * TPA02 - RLS reads the THIRD-PARTY token's claims. The email tells the
 * customer that under third-party auth their policies key off the external
 * provider's subject rather than a foreign key into auth.users; this proves
 * `auth.uid()` resolves to the token's `sub` and a `using (owner = auth.uid())`
 * policy filters on it.
 *
 *   TPA02a  a table with RLS `owner = auth.uid()`, two rows: one owned by the
 *           token's sub, one by a different uuid. The external token reads back
 *           exactly the sub's row - so auth.uid() = the third-party sub. PASS if
 *           exactly one row and it is the sub's.
 *   TPA02b  a custom claim rides through: mint the token with an extra claim and
 *           read it back via `auth.jwt()->>'<claim>'` exposed through a
 *           SECURITY DEFINER function. PASS if the value round-trips - the
 *           provider's claims are visible to policies, not just the sub.
 *
 * Not settled by this module: role mapping beyond `authenticated` (the token
 * carries role=authenticated; anon/custom roles are not exercised here).
 *
 * DESTRUCTIVE: deploys a JWKS function, registers one issuer, creates a table
 * and a function; all removed in finally. Self-skips without a ref or anon key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { cleanupPrefix } from "../../edge-function-limits/lib/ef";
import { apiGet, deleteTpa, generateIdp, mint, publishJwks, registerTpa, sleep } from "../lib/idp";

const P = "pvlab-tpa02-";
const TABLE = "public.tpa_items";

const mod: TestModule = {
  id: "TPA02",
  title: "RLS reads the third-party token's claims (auth.uid() = the external sub)",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "TPA02", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const slug = `${P}jwks`;
    let tpaId = "";
    const sub = crypto.randomUUID();
    const other = crypto.randomUUID();
    const marker = `tpa02-${Date.now()}`;
    try {
      await cleanupPrefix(ctx, P);
      await sql(ctx, `create table if not exists ${TABLE} (id int primary key, owner uuid, note text)`);
      await sql(ctx, `insert into ${TABLE} values (1, '${sub}', 'mine'), (2, '${other}', 'theirs') on conflict (id) do update set owner = excluded.owner`);
      await sql(ctx, `alter table ${TABLE} enable row level security`);
      await sql(ctx, `drop policy if exists tpa_items_owner on ${TABLE}`);
      await sql(ctx, `create policy tpa_items_owner on ${TABLE} for select to authenticated using (owner = auth.uid())`);
      // A SECURITY DEFINER reader for a custom claim, exposed to PostgREST as an RPC.
      await sql(ctx, `create or replace function public.tpa_claim(name text) returns text language sql security definer stable as $$ select auth.jwt()->>name $$`);

      const idp = await generateIdp();
      const pub = await publishJwks(ctx, slug, idp.publicJwk);
      if (!pub.ok) return [{ id: "TPA02", title: this.title, status: "fail", detail: `JWKS not served (${pub.status})` }];
      const reg = await registerTpa(ctx, pub.url);
      tpaId = reg.id;
      if (!tpaId) return [{ id: "TPA02", title: this.title, status: "fail", detail: `registration failed ${reg.status}: ${reg.body}` }];

      const token = await mint(idp, { sub, iss: pub.url, extra: { org_marker: marker } });

      // Poll until the issuer resolves (first-time kid propagation).
      const t0 = Date.now();
      let read = await apiGet(ctx, `/rest/v1/tpa_items?select=id,note,owner`, keys.anon, token);
      while (Date.now() - t0 < 120_000 && read.status !== 200) {
        await sleep(5_000);
        read = await apiGet(ctx, `/rest/v1/tpa_items?select=id,note,owner`, keys.anon, token);
      }
      const rows = (Array.isArray(read.json) ? read.json : []) as { id: number; note: string; owner: string }[];
      const onlyMine = rows.length === 1 && rows[0]?.owner === sub && rows[0]?.note === "mine";
      out.push({
        id: "TPA02a",
        title: "RLS owner = auth.uid() filters on the third-party sub",
        status: onlyMine ? "pass" : "fail",
        detail: onlyMine
          ? `read returned exactly the sub's row (id ${rows[0]?.id}, note '${rows[0]?.note}') - auth.uid() resolved to the external sub`
          : `expected 1 row owned by the sub; got ${rows.length}: ${JSON.stringify(rows).slice(0, 160)} (status ${read.status} ${read.code})`,
        measurements: { status: read.status, rows: rows.length, first_owner_is_sub: rows[0]?.owner === sub ? 1 : 0 },
      });

      // TPA02b - a custom claim visible via auth.jwt().
      const rpc = await apiGet(ctx, `/rest/v1/rpc/tpa_claim?name=org_marker`, keys.anon, token);
      const got = typeof rpc.json === "string" ? rpc.json : JSON.stringify(rpc.json);
      out.push({
        id: "TPA02b",
        title: "a custom claim rides through to auth.jwt()",
        status: rpc.status === 200 && got.includes(marker) ? "pass" : "fail",
        detail: `rpc tpa_claim('org_marker') -> ${rpc.status} ${got.slice(0, 80)} (minted ${marker})`,
        measurements: { status: rpc.status, claim_roundtrips: got.includes(marker) ? 1 : 0 },
      });
    } catch (e) {
      out.push({ id: "TPA02", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      await sql(ctx, `drop function if exists public.tpa_claim(text)`);
      await sql(ctx, `drop table if exists ${TABLE}`);
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "TPA02z", title: "cleanup: delete issuer, function, table, JWKS", status: c.left.length ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
