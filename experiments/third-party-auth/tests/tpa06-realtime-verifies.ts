/**
 * TPA06 - does managed Realtime VERIFY a third-party token, and do its RLS
 * checks read the token's claims? The token rides in the `phx_join` payload's
 * `access_token` (and later `access_token` pushes), which the API gateway
 * does not parse as a bearer, so a reply here is Realtime's own. Same token
 * set as TPA05 (A acme with can_write, A2 acme without can_write, B globex,
 * noclaim, forged = registered kid signed by another key, unknownkid,
 * expired) plus `anon` = no access_token at all (the socket's apikey).
 *
 *   TPA06-setup  issuer registered; first PostgREST 200, then the first
 *                successful private join for token A (seconds after the
 *                PostgREST 200), and every distinct error reply on the way.
 *   TPA06a-*     join the PRIVATE channel `tenant:acme`, one socket per token.
 *                realtime.messages SELECT policy: topic = 'tenant:' || tenant
 *                claim. Expect A and A2 joined, every other token refused.
 *   TPA06b       realtime.send from SQL to tenant:acme and tenant:globex:
 *                which joined sockets receive which message.
 *   TPA06c-*     client Broadcast (ack) on tenant:acme from A and A2; the
 *                INSERT policy also needs can_write = 'true'. Who receives.
 *   TPA06d-*     Postgres Changes INSERT on a table with RLS `tenant =
 *                auth.jwt()->>'tenant'`, one socket each for A, B, anon and
 *                forged. Canary rows first (a fresh subscription has dropped
 *                its first change before, realtime-surface RT01a), then 3 acme
 *                and 3 globex rows; per socket, which tenants arrived.
 *   TPA06e-*     an open private channel whose token expires 30 s after mint:
 *                left alone (E), refreshed at ~10 s with a fresh token via an
 *                `access_token` push (R), or pushed a FORGED token at ~10 s
 *                (F). Every frame on each topic is recorded with its time
 *                relative to the 30 s expiry; a realtime.send at ~45 s shows
 *                which channel still receives.
 *
 * n = 1 per row. Not settled here: Presence, and the `realtime.topic()` +
 * extension policy split between broadcast and presence.
 *
 * DESTRUCTIVE: deploys a JWKS function, registers one issuer, creates a table
 * (added to the supabase_realtime publication) and two realtime.messages
 * policies; all removed in finally. Runs against PVLAB_REF.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { fetchKeys, sql } from "../../../harness/src/platform";
import { cleanupPrefix } from "../../edge-function-limits/lib/ef";
import { deleteTpa, generateIdp, mint, setupIssuer, sleep } from "../lib/idp";
import { frameText, RtSock } from "../lib/rtws";

const P = "pvlab-tpa06-";
const TABLE = "public.tpa06_rows";
const ACME = "tenant:acme";
const GLOBEX = "tenant:globex";

const mod: TestModule = {
  id: "TPA06",
  title: "Realtime verifies a third-party token: private Broadcast and Postgres Changes keyed on a claim",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "TPA06", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const socks: RtSock[] = [];
    const sock = async () => {
      const s = new RtSock(ctx.apiHost, keys.anon);
      socks.push(s);
      await s.open();
      return s;
    };
    let tpaId = "";
    const q = async (text: string) => {
      const r = await sql(ctx, text);
      if (r.status >= 300) throw new Error(`sql ${r.status}: ${r.error}`);
      return r.rows;
    };
    try {
      await cleanupPrefix(ctx, P);
      await q(`drop table if exists ${TABLE}`);
      await q(`create table ${TABLE} (id bigserial primary key, tenant text not null, note text)`);
      await q(`alter table ${TABLE} enable row level security`);
      await q(`create policy tpa06_rows_tenant on ${TABLE} for select to authenticated using (tenant = (auth.jwt()->>'tenant'))`);
      await q(`alter publication supabase_realtime add table ${TABLE}`);
      for (const p of ["tpa06_bc_read", "tpa06_bc_write"]) await q(`drop policy if exists ${p} on realtime.messages`);
      await q(`create policy tpa06_bc_read on realtime.messages for select to authenticated using (realtime.topic() = 'tenant:' || (auth.jwt()->>'tenant'))`);
      await q(
        `create policy tpa06_bc_write on realtime.messages for insert to authenticated with check (realtime.topic() = 'tenant:' || (auth.jwt()->>'tenant') and (auth.jwt()->>'can_write') = 'true')`,
      );

      const iss = await setupIssuer(ctx, `${P}jwks`, keys.anon, `/rest/v1/tpa06_rows?select=id`);
      tpaId = iss.tpaId;
      const tok = (tenant?: string, extra: Record<string, unknown> = {}, ttlSeconds = 3600) =>
        mint(iss.idp, { sub: crypto.randomUUID(), iss: iss.iss, ttlSeconds, extra: { ...(tenant ? { tenant } : {}), ...extra } });
      const A = await tok("acme", { can_write: "true" });
      const A2 = await tok("acme");
      const B = await tok("globex");
      const noclaim = await tok();
      const other = await generateIdp();
      const forged = await mint({ ...other, kid: iss.idp.kid }, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "acme" } });
      const unknownkid = await mint(other, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "acme" } });
      const expired = await tok("acme", {}, -600);

      // Warm-up: a public join creates the day's realtime.messages partition
      // (realtime-surface RT03: a private join on a fresh project answered
      // MissingPartition until the first join of any kind).
      const warm = await sock();
      await warm.join("warmup", { private: false });
      await sleep(2_000);

      // Poll a private join with token A until Realtime accepts the issuer.
      const t0 = Date.now();
      const seen = new Set<string>();
      let accepted = -1;
      let probeSock: RtSock | null = null;
      while (iss.tpaId && Date.now() - t0 < 180_000) {
        probeSock = await sock();
        const r = await probeSock.join(ACME, { private: true }, A);
        if (r.status === "ok") {
          accepted = Math.round((Date.now() - t0) / 1000);
          break;
        }
        seen.add(`${r.status}: ${r.detail}`.slice(0, 160));
        probeSock.close();
        await sleep(5_000);
      }
      out.push({
        id: "TPA06-setup",
        title: "issuer registered; Realtime accepts the first private join for token A",
        status: iss.tpaId && accepted >= 0 ? "pass" : "fail",
        detail: `jwks ${iss.jwksStatus}; register ${iss.regStatus}; PostgREST first 200 ${iss.restAcceptedAfterS}s after registration; first private join ok ${accepted}s after the PostgREST 200; replies before that: ${seen.size ? [...seen].join(" | ") : "none"}`,
        measurements: { register_status: iss.regStatus, rest_accepted_after_s: iss.restAcceptedAfterS, realtime_accepted_after_rest_s: accepted },
      });
      if (accepted < 0) return out;

      // TPA06a - private join per token, one socket each.
      const joined: Record<string, RtSock> = {};
      const cases: [string, string | undefined, boolean][] = [
        ["A", A, true],
        ["A2", A2, true],
        ["B", B, false],
        ["noclaim", noclaim, false],
        ["forged", forged, false],
        ["unknownkid", unknownkid, false],
        ["expired", expired, false],
        ["anon", undefined, false],
      ];
      for (const [name, t, allow] of cases) {
        const s = await sock();
        const r = await s.join(ACME, { private: true, broadcast: { self: true, ack: true } }, t);
        await sleep(500);
        const after = s.on(ACME).filter((f) => f.event !== "phx_reply").map(frameText);
        if (r.status === "ok") joined[name] = s;
        out.push({
          id: `TPA06a-${name}`,
          title: `private join ${ACME} with token ${name}`,
          status: (r.status === "ok") === allow ? "pass" : "fail",
          detail: `phx_reply ${r.raw}${after.length ? `; then ${after.join(" | ")}` : ""}${s.closedWhy ? `; socket ${s.closedWhy}` : ""} (expected ${allow ? "joined" : "refused"})`,
          measurements: { joined: r.status === "ok" ? 1 : 0 },
        });
      }

      // TPA06b - database-sent Broadcast to each tenant topic.
      const bSock = await sock();
      const bJoin = await bSock.join(GLOBEX, { private: true }, B);
      const tb = Date.now();
      await q(`select realtime.send('{"n":"to-acme"}'::jsonb, 'dbsend', '${ACME}', true), realtime.send('{"n":"to-globex"}'::jsonb, 'dbsend', '${GLOBEX}', true)`);
      await sleep(5_000);
      const gotDb = (s: RtSock | undefined, topic: string) => (s ? s.on(topic, "broadcast", tb).filter((f) => f.payload?.event === "dbsend").map((f) => String(f.payload?.payload?.n)) : []);
      const aGot = gotDb(joined.A, ACME);
      const a2Got = gotDb(joined.A2, ACME);
      const bGot = gotDb(bSock, GLOBEX);
      out.push({
        id: "TPA06b",
        title: "realtime.send to each tenant topic reaches only that topic's joined sockets",
        status: aGot.join() === "to-acme" && a2Got.join() === "to-acme" && bGot.join() === "to-globex" ? "pass" : "fail",
        detail: `B private join ${GLOBEX}: ${bJoin.status}${bJoin.status !== "ok" ? ` ${bJoin.detail}` : ""}; A received ${JSON.stringify(aGot)}, A2 ${JSON.stringify(a2Got)}, B ${JSON.stringify(bGot)}`,
        measurements: { a_received: aGot.length, a2_received: a2Got.length, b_received: bGot.length },
      });

      // TPA06c - client Broadcast with ack from A (can_write) and A2 (no can_write).
      for (const [name, s, allow] of [
        ["A", joined.A, true],
        ["A2", joined.A2, false],
      ] as [string, RtSock | undefined, boolean][]) {
        if (!s) {
          out.push({ id: `TPA06c-${name}`, title: `client Broadcast from ${name}`, status: "fail", detail: "socket not joined in TPA06a" });
          continue;
        }
        const tc = Date.now();
        const joinRef = s.frames.find((f) => f.topic === `realtime:${ACME}` && f.event === "phx_reply")?.ref ?? undefined;
        const ref = s.push(`realtime:${ACME}`, "broadcast", { type: "broadcast", event: "client", payload: { from: name } }, joinRef);
        const ack = await s.reply(ref, 5_000);
        await sleep(3_000);
        const recv = (x: RtSock | undefined) => (x ? x.on(ACME, "broadcast", tc).filter((f) => f.payload?.event === "client" && f.payload?.payload?.from === name).length : 0);
        const sys = s.on(ACME, undefined, tc).filter((f) => f.event !== "broadcast" && f.event !== "phx_reply").map(frameText);
        const delivered = recv(joined.A) + recv(joined.A2);
        out.push({
          id: `TPA06c-${name}`,
          title: `client Broadcast (ack) on ${ACME} from ${name} (${allow ? "can_write=true" : "no can_write claim"})`,
          status: (delivered > 0) === allow ? "pass" : "fail",
          detail: `ack ${ack.status}${ack.raw ? ` ${ack.raw}` : ` ${ack.detail}`}; received by A ${recv(joined.A)}, by A2 ${recv(joined.A2)}${sys.length ? `; other frames ${sys.join(" | ")}` : ""} (expected ${allow ? "delivered" : "not delivered"})`,
          measurements: { delivered },
        });
      }

      // TPA06d - Postgres Changes with RLS keyed on the claim.
      const pcCfg = { private: false, postgres_changes: [{ event: "INSERT", schema: "public", table: "tpa06_rows" }] };
      const pc: Record<string, { s: RtSock; reply: string; status: string }> = {};
      for (const [name, t] of [
        ["A", A],
        ["B", B],
        ["anon", undefined],
        ["forged", forged],
      ] as [string, string | undefined][]) {
        const s = await sock();
        const r = await s.join(`pc-${name}`, pcCfg, t);
        pc[name] = { s, reply: r.raw || r.detail, status: r.status };
      }
      await sleep(3_000);
      const rowsOn = (name: string, since: number) =>
        (pc[name]?.s.on(`pc-${name}`, "postgres_changes", since) ?? []).map((f) => ({ tenant: String(f.payload?.data?.record?.tenant), note: String(f.payload?.data?.record?.note) }));
      // canaries until A has seen an acme row and B a globex row (or 40 s)
      const tCan = Date.now();
      let k = 0;
      while (Date.now() - tCan < 40_000) {
        await q(`insert into ${TABLE} (tenant, note) values ('acme', 'canary-${k}'), ('globex', 'canary-${k}')`);
        k++;
        await sleep(2_000);
        const a = rowsOn("A", tCan).some((r) => r.tenant === "acme");
        const b = rowsOn("B", tCan).some((r) => r.tenant === "globex");
        if (a && b) break;
      }
      const tM = Date.now();
      await q(`insert into ${TABLE} (tenant, note) select t, 'm-' || g from (values ('acme'), ('globex')) v(t), generate_series(1, 3) g`);
      await sleep(8_000);
      const expect: Record<string, [number, number]> = { A: [3, 0], B: [0, 3], anon: [0, 0], forged: [0, 0] };
      for (const name of ["A", "B", "anon", "forged"]) {
        const got = rowsOn(name, tM).filter((r) => r.note.startsWith("m-"));
        const acme = got.filter((r) => r.tenant === "acme").length;
        const globex = got.filter((r) => r.tenant === "globex").length;
        const sys = (pc[name]?.s.on(`pc-${name}`, "system") ?? []).map(frameText);
        const [ea, eg] = expect[name]!;
        out.push({
          id: `TPA06d-${name}`,
          title: `Postgres Changes INSERT with RLS tenant = claim, token ${name}`,
          status: acme === ea && globex === eg ? "pass" : "fail",
          detail: `join ${pc[name]?.status} ${String(pc[name]?.reply).slice(0, 200)}; system ${sys.length ? sys.join(" | ") : "none"}; measured rows received acme ${acme} of 3, globex ${globex} of 3 (canary rounds ${k}; expected acme ${ea}, globex ${eg})`,
          measurements: { join_ok: pc[name]?.status === "ok" ? 1 : 0, acme_rows: acme, globex_rows: globex, canary_rounds: k },
        });
      }

      // TPA06e - expiry and refresh on an open private channel.
      const tE = Date.now();
      const E = await tok("acme", {}, 30);
      const R = await tok("acme", {}, 30);
      const F = await tok("acme", {}, 30);
      const expAt = (Math.floor(tE / 1000) + 30) * 1000;
      const es: Record<string, { s: RtSock; join: string }> = {};
      for (const [name, t] of [
        ["E", E],
        ["R", R],
        ["F", F],
      ] as [string, string][]) {
        const s = await sock();
        const r = await s.join(ACME, { private: true }, t);
        es[name] = { s, join: r.status };
      }
      await sleep(Math.max(0, tE + 10_000 - Date.now()));
      const refR = await tok("acme");
      const jr = (n: string) => es[n]!.s.frames.find((f) => f.topic === `realtime:${ACME}` && f.event === "phx_reply")?.ref ?? undefined;
      const rRef = es.R!.s.push(`realtime:${ACME}`, "access_token", { access_token: refR }, jr("R"));
      const forged2 = await mint({ ...other, kid: iss.idp.kid }, { sub: crypto.randomUUID(), iss: iss.iss, extra: { tenant: "acme" } });
      const fRef = es.F!.s.push(`realtime:${ACME}`, "access_token", { access_token: forged2 }, jr("F"));
      await sleep(Math.max(0, expAt + 15_000 - Date.now()));
      const tAfter = Date.now();
      await q(`select realtime.send('{"n":"after-expiry"}'::jsonb, 'dbsend', '${ACME}', true)`);
      await sleep(5_000);
      for (const [name, label, pushRef] of [
        ["E", "left alone", ""],
        ["R", "refreshed at ~10 s with a fresh token", rRef],
        ["F", "pushed a forged token at ~10 s", fRef],
      ] as [string, string, string][]) {
        const s = es[name]!.s;
        const frames = s.on(ACME, undefined, tE).filter((f) => !(f.event === "phx_reply" && f.ref === jr(name)) && !(f.event === "broadcast"));
        const timeline = frames.map((f) => `${((f.at - expAt) / 1000).toFixed(1)}s ${frameText(f)}${f.ref && f.ref === pushRef ? " (reply to access_token push)" : ""}`);
        const after = s.on(ACME, "broadcast", tAfter).filter((f) => f.payload?.event === "dbsend").length;
        out.push({
          id: `TPA06e-${name}`,
          title: `private channel whose 30 s token is ${label}`,
          status: "info",
          detail: `join ${es[name]!.join}; frames (seconds relative to exp): ${timeline.length ? timeline.join(" | ") : "none"}; realtime.send at ${((tAfter - expAt) / 1000).toFixed(0)}s after exp received ${after}${s.closedWhy ? `; socket ${s.closedWhy}` : ""}`,
          measurements: { frames: timeline.length, received_after_exp: after },
        });
      }
    } catch (e) {
      out.push({ id: "TPA06", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      for (const s of socks) s.close();
      const notes: string[] = [];
      if (tpaId) notes.push(`tpa delete ${await deleteTpa(ctx, tpaId)}`);
      for (const p of ["tpa06_bc_read", "tpa06_bc_write"]) await sql(ctx, `drop policy if exists ${p} on realtime.messages`);
      await sql(ctx, `drop table if exists ${TABLE}`);
      const c = await cleanupPrefix(ctx, P).catch(() => ({ deleted: 0, left: ["threw"] }));
      notes.push(`functions deleted ${c.deleted}${c.left.length ? ` LEFT ${c.left.join(",")}` : ""}`);
      out.push({ id: "TPA06z", title: "cleanup: issuer, policies, table, JWKS function", status: c.left.length ? "fail" : "pass", detail: notes.join("; ") });
    }
    return out;
  },
};

export default mod;
