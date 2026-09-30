/**
 * MS11 - Postgres Changes to two tenants' subscribers, with RLS off and on,
 * authenticated by tokens from an external issuer that carry Clerk's `o`
 * (organisation) claim shape.
 *
 * The shape under test: an app uses an external identity provider (not
 * Supabase Auth), keeps tenant messaging tables in the `supabase_realtime`
 * publication, and calls `realtime.setAuth(<external jwt>)` on each client.
 * Realtime filters Postgres Changes per subscriber by evaluating the table's
 * RLS as that subscriber; with RLS off there is nothing to evaluate. Rows:
 *
 *   MS11a  RLS off: subscriber A (token `o.id = tenant-a`) and subscriber B
 *          (`o.id = tenant-b`) each join; one INSERT per tenant; events each
 *          subscriber receives. Expected: both receive both.
 *   MS11b  RLS on with `using (tenant_id = auth.jwt()->'o'->>'id')`: the
 *          same; expected one event each, their own tenant's.
 *   MS11c  RLS on, subscriber joins with the anon key only (no token): events
 *          received, or the join/refusal text.
 *   MS11d  a token from an issuer that is NOT registered as third-party auth:
 *          the join reply text - what `setAuth` with an unregistered JWT does.
 *
 * Tokens are ES256 JWTs minted in-process with `role: authenticated` and
 * `o: {id, rol, slg}`; the JWKS is served from an Edge Function on the
 * project and registered via `POST /config/auth/third-party-auth` (the
 * third-party-auth experiment's helper). DESTRUCTIVE: creates a table, adds
 * it to the publication, registers and deletes a third-party issuer, deploys
 * a JWKS function (left for `make destroy`). Not settled: Broadcast, which
 * the shape under test does not use, and token refresh mid-subscription.
 */
import WebSocket from "ws";
import { sql } from "../../../harness/src/platform";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deleteTpa, generateIdp, mint, publishJwks, registerTpa } from "../../third-party-auth/lib/idp";
import { errText, sleep } from "../lib/setup";

const TABLE = "public.ms_msg";
const COLLECT_MS = 8000;

interface Sub {
  label: string;
  events: string[];
  joinReply: string;
  errors: string[];
  close: () => void;
}

/** Join `realtime:<topic>` with a postgres_changes config; optional access_token as setAuth would send. */
function subscribe(ctx: Ctx, label: string, token: string | null): Promise<Sub> {
  return new Promise((resolve) => {
    const sub: Sub = { label, events: [], joinReply: "", errors: [], close: () => {} };
    const ws = new WebSocket(`wss://${ctx.apiHost}/realtime/v1/websocket?apikey=${ctx.anonKey}&vsn=1.0.0`, { handshakeTimeout: 10_000 });
    sub.close = () => {
      try {
        ws.close();
      } catch {}
    };
    const topic = `realtime:ms11-${label}`;
    const settle = setTimeout(() => resolve(sub), 12_000);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          topic,
          event: "phx_join",
          payload: {
            config: { postgres_changes: [{ event: "INSERT", schema: "public", table: "ms_msg" }], private: false },
            ...(token ? { access_token: token } : {}),
          },
          ref: "1",
        }),
      );
      if (token) ws.send(JSON.stringify({ topic, event: "access_token", payload: { access_token: token }, ref: "2" }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as { event?: string; payload?: Record<string, unknown> };
      if (m.event === "phx_reply" && !sub.joinReply) {
        sub.joinReply = JSON.stringify(m.payload).slice(0, 300);
        clearTimeout(settle);
        resolve(sub);
      } else if (m.event === "postgres_changes") {
        const rec = ((m.payload as { data?: { record?: Record<string, unknown> } })?.data?.record ?? {}) as Record<string, unknown>;
        sub.events.push(String(rec.tenant_id ?? JSON.stringify(m.payload).slice(0, 80)));
      } else if (m.event === "system" || m.event === "error") {
        sub.errors.push(JSON.stringify(m.payload).slice(0, 200));
      }
    });
    ws.on("error", (e) => {
      sub.errors.push(errText(e));
      clearTimeout(settle);
      resolve(sub);
    });
  });
}

const mod: TestModule = {
  id: "MS11",
  title: "Postgres Changes per tenant with external-issuer tokens: RLS off vs on",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    const idp = await generateIdp();
    const rogue = await generateIdp();
    let tpaId = "";
    const setup = await sql(
      ctx,
      `create table if not exists ${TABLE} (id serial primary key, tenant_id text not null, body text not null, created_at timestamptz default now());
       alter table ${TABLE} disable row level security;
       grant select on ${TABLE} to anon, authenticated;
       do $$ begin
         if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ms_msg') then
           alter publication supabase_realtime add table ${TABLE};
         end if;
       end $$;`,
    );
    if (setup.status >= 300) return [{ id: "MS11", title: mod.title, status: "fail", detail: `setup failed HTTP ${setup.status}: ${setup.error}` }];

    try {
      const pub = await publishJwks(ctx, "ms11-jwks", idp.publicJwk);
      if (!pub.ok) return [{ id: "MS11", title: mod.title, status: "fail", detail: `JWKS function not live: HTTP ${pub.status}` }];
      const reg = await registerTpa(ctx, pub.url);
      tpaId = reg.id;
      if (!tpaId) return [{ id: "MS11", title: mod.title, status: "fail", detail: `third-party registration failed ${reg.status}: ${reg.body}` }];
      await sleep(5000);

      const tok = (t: string, who = idp) => mint(who, { sub: `user-${t}`, iss: pub.url, extra: { o: { id: t, rol: "admin", slg: t } } });
      const tokA = await tok("tenant-a");
      const tokB = await tok("tenant-b");

      const round = async (id: string, title: string, rlsOn: boolean, subsSpec: [string, string | null][]) => {
        const subs = await Promise.all(subsSpec.map(([l, t]) => subscribe(ctx, l, t)));
        await sleep(1500);
        const ins = await sql(ctx, `insert into ${TABLE}(tenant_id, body) values ('tenant-a','${id}-a'), ('tenant-b','${id}-b')`);
        await sleep(COLLECT_MS);
        for (const s of subs) s.close();
        const m: Record<string, string | number> = { rls: rlsOn ? "on" : "off", insert_http: ins.status };
        const detail: string[] = [];
        for (const s of subs) {
          m[`${s.label}_events`] = s.events.length;
          m[`${s.label}_tenants_seen`] = [...new Set(s.events)].sort().join("+") || "none";
          m[`${s.label}_join`] = s.joinReply.slice(0, 120);
          if (s.errors.length) m[`${s.label}_errors`] = s.errors.join(" | ").slice(0, 160);
          detail.push(`${s.label}: ${s.events.length} event(s) [${[...new Set(s.events)].sort().join(",") || "-"}]${s.errors.length ? ` errors ${s.errors.length}` : ""}`);
        }
        out.push({ id, title, status: "info", detail: detail.join("; "), measurements: m, evidence: subs.map((s) => `${s.label} join: ${s.joinReply}\n${s.label} errors: ${s.errors.join("\n")}`).join("\n") });
      };

      await round("MS11a", "RLS off: two tenants' subscribers, one INSERT per tenant", false, [["a", tokA], ["b", tokB]]);

      const rls = await sql(
        ctx,
        `alter table ${TABLE} enable row level security;
         drop policy if exists ms_msg_tenant on ${TABLE};
         create policy ms_msg_tenant on ${TABLE} for select to authenticated using (tenant_id = (auth.jwt()->'o'->>'id'));`,
      );
      if (rls.status >= 300) out.push({ id: "MS11b", title: "RLS on", status: "fail", detail: `policy setup failed: ${rls.error}` });
      else {
        await round("MS11b", "RLS on, policy tenant_id = auth.jwt()->'o'->>'id'", true, [["a", tokA], ["b", tokB]]);
        await round("MS11c", "RLS on, subscriber with the anon key only (no token)", true, [["anon", null]]);
        const rogueTok = await tok("tenant-a", rogue);
        await round("MS11d", "RLS on, token from an issuer that is not registered", true, [["rogue", rogueTok]]);
      }
      // Post-hoc verdicts on the info rows.
      const a = out.find((r) => r.id === "MS11a");
      if (a && a.measurements) a.status = a.measurements.a_events === 2 && a.measurements.b_events === 2 ? "pass" : "info";
      const b = out.find((r) => r.id === "MS11b");
      if (b && b.measurements) b.status = b.measurements.a_tenants_seen === "tenant-a" && b.measurements.b_tenants_seen === "tenant-b" ? "pass" : "info";
    } finally {
      if (tpaId) await deleteTpa(ctx, tpaId);
      await sql(ctx, `alter publication supabase_realtime drop table ${TABLE}`).catch(() => {});
      await sql(ctx, `drop table if exists ${TABLE}`).catch(() => {});
    }
    return out;
  },
};
export default mod;
