/**
 * TPA04 - the GoTrue sign-in rate-limit surface is not on the third-party path.
 * The auth-rate-limits experiment measured those limits on GoTrue's endpoints
 * (anonymous burst, email cap, per-IP token bucket). Under third-party auth the
 * client obtains its token from the external IdP, so none of those endpoints is
 * called during login - this records that a token minted with ZERO GoTrue calls
 * is a working data credential, i.e. sign-in throughput is bounded by the
 * external IdP, not by Supabase's GoTrue limits.
 *
 *   TPA04a  mint N external tokens back-to-back and read PostgREST with each,
 *           making no /auth/v1 sign-in call at all. Record how many succeed and
 *           that no GoTrue 429 appears (there is no GoTrue request to rate
 *           limit). INFO with the counts - a proof by construction that the
 *           sign-in limiter is bypassed, not a burst against a limit.
 *
 * Not settled by this module: the external IdP's own rate limits (out of
 * scope - they are the provider's, not Supabase's), and the PostgREST /
 * gateway request limits, which still apply to the data calls themselves and
 * are a separate ceiling from GoTrue's sign-in limits.
 *
 * DESTRUCTIVE: deploys a JWKS function and registers one issuer; both removed
 * in finally. Self-skips without a ref or anon key.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { cleanupPrefix } from "../../edge-function-limits/lib/ef";
import { apiGet, deleteTpa, generateIdp, mint, publishJwks, registerTpa, sleep } from "../lib/idp";

const P = "pvlab-tpa04-";
const TABLE = "public.tpa_rl";
const N = 20;

const mod: TestModule = {
  id: "TPA04",
  title: "Third-party login bypasses the GoTrue sign-in rate-limit surface",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "TPA04", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const slug = `${P}jwks`;
    let tpaId = "";
    try {
      await cleanupPrefix(ctx, P);
      await sql(ctx, `create table if not exists ${TABLE} (id int primary key)`);
      await sql(ctx, `insert into ${TABLE} values (1) on conflict do nothing`);
      await sql(ctx, `alter table ${TABLE} enable row level security`);
      await sql(ctx, `drop policy if exists tpa_rl_read on ${TABLE}`);
      await sql(ctx, `create policy tpa_rl_read on ${TABLE} for select to authenticated using (true)`);

      const idp = await generateIdp();
      const pub = await publishJwks(ctx, slug, idp.publicJwk);
      if (!pub.ok) return [{ id: "TPA04", title: this.title, status: "fail", detail: `JWKS not served (${pub.status})` }];
      const reg = await registerTpa(ctx, pub.url);
      tpaId = reg.id;
      if (!tpaId) return [{ id: "TPA04", title: this.title, status: "fail", detail: `registration failed ${reg.status}: ${reg.body}` }];

      // Warm one token so the issuer kid resolves before counting.
      const warm = await mint(idp, { sub: crypto.randomUUID(), iss: pub.url });
      const t0 = Date.now();
      let r = await apiGet(ctx, `/rest/v1/tpa_rl?select=id`, keys.anon, warm);
      while (Date.now() - t0 < 120_000 && r.status !== 200) {
        await sleep(5_000);
        r = await apiGet(ctx, `/rest/v1/tpa_rl?select=id`, keys.anon, warm);
      }

      // Mint N DISTINCT-subject tokens with zero GoTrue calls, read PostgREST with each.
      let ok = 0;
      let gotrue429 = 0;
      const statuses: Record<string, number> = {};
      for (let i = 0; i < N; i++) {
        const tok = await mint(idp, { sub: crypto.randomUUID(), iss: pub.url });
        const res = await apiGet(ctx, `/rest/v1/tpa_rl?select=id`, keys.anon, tok);
        statuses[String(res.status)] = (statuses[String(res.status)] ?? 0) + 1;
        if (res.status === 200) ok++;
        if (res.status === 429) gotrue429++; // would be a PostgREST/gateway limit, never a GoTrue sign-in limit
      }
      out.push({
        id: "TPA04a",
        title: `${N} distinct external logins, zero GoTrue sign-in calls`,
        status: "info",
        detail: `${ok}/${N} tokens read PostgREST; statuses ${JSON.stringify(statuses)} - each login minted at the IdP with no /auth/v1 call, so GoTrue's anonymous/email/token buckets never entered the path`,
        measurements: { minted: N, rest_ok: ok, non_200: N - ok, statuses: JSON.stringify(statuses) },
      });
    } catch (e) {
      out.push({ id: "TPA04", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      await sql(ctx, `drop table if exists ${TABLE}`);
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "TPA04z", title: "cleanup: delete issuer, table, JWKS", status: c.left.length ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
