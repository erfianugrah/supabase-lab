/**
 * S26 - Auth and edge questions with no run behind them.
 *
 *   S26a  an unsigned token (alg "none") claiming role authenticated, sent to
 *         the Data API and to Auth's GET /user. Lab work so far forged or
 *         mis-signed tokens only with real algorithms (edge-resilience W01).
 *   S26b  anonymous sign-in: the JWT's role claim, and whether a plain
 *         "to authenticated using (true)" policy admits an anonymous user.
 *         Then the restrictive is_anonymous policy the Auth docs recommend.
 *   S26c  sb_secret_ keys: refused when the request looks like a browser?
 *         Never measured; DD04 used the key from a server only. Also
 *         the key in Authorization alone, with no apikey header.
 *   S26d  Realtime: does the hosted socket accept an upgrade carrying a
 *         foreign Origin header (check_origin)?
 *
 * Self-provisioned: one Pro-org Micro (lib/project.ts), deleted in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { errCode, httpBody, waitFor } from "../lib/sec.js";
import { createProject, deleteProject, sleep } from "../lib/project.js";

const TABLE = "sec26_docs";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const SERVER_UA = "curl/8.7.1";

async function q(ctx: Ctx, ref: string, query: string): Promise<{ ok: boolean; json: unknown; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ref}/database/query`, { query }, 60_000);
  return { ok: r.status >= 200 && r.status < 300, json: r.json, text: r.text.slice(0, 300) };
}

function b64url(s: string): string {
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function claims(token: string): Record<string, unknown> {
  try {
    const b64 = (token.split(".")[1] ?? "").replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
  } catch {
    return {};
  }
}

const rowsOf = (json: unknown) => (Array.isArray(json) ? json.length : -1);

/** Open a socket, wait for open or close/error, then close. Bun's WebSocket takes headers. */
function wsProbe(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<{ opened: boolean; closeCode: number; error: string; replied: boolean }> {
  return new Promise((resolve) => {
    let opened = false;
    let replied = false;
    let closeCode = 0;
    let error = "";
    const WS = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket;
    const ws = new WS(url, { headers });
    const done = () => {
      clearTimeout(t);
      try { ws.close(); } catch { /* already closed */ }
      resolve({ opened, closeCode, error, replied });
    };
    const t = setTimeout(done, timeoutMs);
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: "1" }));
    };
    ws.onmessage = () => {
      replied = true;
      done();
    };
    ws.onerror = (e) => {
      error = String((e as { message?: string }).message ?? "error").slice(0, 80);
    };
    ws.onclose = (e) => {
      closeCode = e.code;
      done();
    };
  });
}

const mod: TestModule = {
  id: "S26",
  title: "alg none tokens, anonymous sign-in role, sb_secret_ from a browser, Realtime Origin",
  where: "local",
  requires: ["pat"],
  destructive: true,
  timeoutMs: 30 * 60_000,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const out: TestResult[] = [];
    if (!ctx.orgs.pro) return [{ id: "S26", title: mod.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    let ref = "";
    try {
      const p = await createProject(ctx, "pvlab-s26-", (r) => {
        ref = r;
        ctx.log(`S26 project ${r}`);
      });
      const base = `https://${p.host}`;
      const rest = `${base}/rest/v1`;
      const k = await mgmt(ctx, "GET", `/projects/${ref}/api-keys?reveal=true`);
      const keyRows = (Array.isArray(k.json) ? k.json : []) as { type?: string; api_key?: string }[];
      const secret = keyRows.find((x) => x.type === "secret")?.api_key ?? "";
      const publishable = keyRows.find((x) => x.type === "publishable")?.api_key ?? "";
      const setup = await q(ctx, ref, `
create table public.${TABLE} (id bigint generated always as identity primary key, body text);
insert into public.${TABLE} (body) values ('a'), ('b'), ('c');
alter table public.${TABLE} enable row level security;
grant select on public.${TABLE} to anon, authenticated;
create policy s26_auth_read on public.${TABLE} for select to authenticated using (true);
notify pgrst, 'reload schema';
`);
      out.push({
        id: "S26s",
        title: "Setup: self-provisioned Pro-org Micro, one RLS table readable by authenticated",
        status: setup.ok ? "info" : "fail",
        detail: `created in ${p.createS} s, ${p.pgVersion}; secret key present ${secret !== ""}, publishable present ${publishable !== ""}; setup ${setup.ok ? "ok" : setup.text}`,
        measurements: { create_s: p.createS, pg: p.pgVersion, secret_key_present: String(secret !== ""), publishable_present: String(publishable !== "") },
      });
      if (!setup.ok) return out;
      const read = (headers: Record<string, string>) => httpBody(`${rest}/${TABLE}?select=id`, { headers });
      await waitFor(async () => (await read({ apikey: p.service, Authorization: `Bearer ${p.service}` })).status === 200, 90_000);

      // ---------------- S26a: alg none.
      const now = Math.floor(Date.now() / 1000);
      const none = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify({
        iss: `${base}/auth/v1`, aud: "authenticated", role: "authenticated",
        sub: crypto.randomUUID(), iat: now, exp: now + 3600,
      }))}.`;
      const noneRest = await read({ apikey: p.anon, Authorization: `Bearer ${none}` });
      const noneUser = await httpBody(`${base}/auth/v1/user`, { headers: { apikey: p.anon, Authorization: `Bearer ${none}` } });
      const noneRestPub = publishable ? await read({ apikey: publishable, Authorization: `Bearer ${none}` }) : undefined;
      out.push({
        id: "S26a",
        title: "an unsigned (alg none) token claiming role authenticated is refused",
        status: noneRest.status === 401 && noneUser.status >= 400 && (!noneRestPub || noneRestPub.status === 401) ? "pass" : "fail",
        detail: `Token header {"alg":"none"}, empty signature, role authenticated, aud authenticated, this project's issuer. Data API with the legacy anon apikey -> ${noneRest.status} ${errCode(noneRest.json, noneRest.text)}, rows ${rowsOf(noneRest.json)}. With the publishable key -> ${noneRestPub ? `${noneRestPub.status} ${errCode(noneRestPub.json, noneRestPub.text)}` : "no publishable key"}. Auth GET /user -> ${noneUser.status} ${errCode(noneUser.json, noneUser.text)}.`,
        measurements: {
          rest_anon_status: noneRest.status,
          rest_anon_code: errCode(noneRest.json, noneRest.text).slice(0, 60),
          rest_publishable_status: noneRestPub?.status ?? -1,
          user_status: noneUser.status,
          user_code: errCode(noneUser.json, noneUser.text).slice(0, 60),
        },
      });

      // ---------------- S26b: anonymous sign-in role vs a "to authenticated" policy.
      const enable = await mgmt(ctx, "PATCH", `/projects/${ref}/config/auth`, { external_anonymous_users_enabled: true });
      let anonSession = await httpBody(`${base}/auth/v1/signup`, { method: "POST", headers: { apikey: p.anon }, body: {} });
      const ok = await waitFor(async () => {
        if (anonSession.status === 200) return true;
        anonSession = await httpBody(`${base}/auth/v1/signup`, { method: "POST", headers: { apikey: p.anon }, body: {} });
        return anonSession.status === 200;
      }, 90_000, 5_000);
      const anonToken = String((anonSession.json as { access_token?: string } | undefined)?.access_token ?? "");
      const ac = claims(anonToken);
      const anonRead1 = await read({ apikey: p.anon, Authorization: `Bearer ${anonToken}` });
      const pwEmail = `s26-${Date.now()}@example.com`;
      const pwPass = `${crypto.randomUUID()}Aa1!`;
      const mk = await httpBody(`${base}/auth/v1/admin/users`, { method: "POST", key: p.service, body: { email: pwEmail, password: pwPass, email_confirm: true } });
      const pwSession = await httpBody(`${base}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: p.anon }, body: { email: pwEmail, password: pwPass } });
      const pwToken = String((pwSession.json as { access_token?: string } | undefined)?.access_token ?? "");
      const restrictive = await q(ctx, ref, `
create policy s26_not_anon on public.${TABLE} as restrictive for select to authenticated
  using ((select (auth.jwt() ->> 'is_anonymous')::boolean) is not true);
notify pgrst, 'reload schema';
`);
      await sleep(3_000);
      const anonRead2 = await read({ apikey: p.anon, Authorization: `Bearer ${anonToken}` });
      const pwRead2 = await read({ apikey: p.anon, Authorization: `Bearer ${pwToken}` });
      out.push({
        id: "S26b",
        title: "an anonymous sign-in carries role authenticated, so a 'to authenticated' policy admits it until a restrictive is_anonymous policy is added",
        status: ok.ok && ac.role === "authenticated" && rowsOf(anonRead1.json) === 3 && rowsOf(anonRead2.json) === 0 && rowsOf(pwRead2.json) === 3 ? "pass" : "fail",
        detail: `PATCH external_anonymous_users_enabled -> ${enable.status}; anonymous sign-in -> ${anonSession.status} after ${ok.elapsedS} s. Its JWT: role "${String(ac.role ?? "")}", is_anonymous ${String(ac.is_anonymous ?? "absent")}, aud "${String(ac.aud ?? "")}". Read under "for select to authenticated using (true)" -> ${anonRead1.status}, ${rowsOf(anonRead1.json)} of 3 rows. Restrictive policy on (auth.jwt()->>'is_anonymous') is not true (${restrictive.ok ? "ok" : restrictive.text}) -> anonymous user ${anonRead2.status}, ${rowsOf(anonRead2.json)} rows; a password user (create ${mk.status}, sign-in ${pwSession.status}) -> ${pwRead2.status}, ${rowsOf(pwRead2.json)} rows.`,
        measurements: {
          anon_enable_patch: enable.status,
          anon_signin_status: anonSession.status,
          anon_role_claim: String(ac.role ?? ""),
          anon_is_anonymous_claim: String(ac.is_anonymous ?? "absent"),
          anon_rows_permissive: rowsOf(anonRead1.json),
          anon_rows_restrictive: rowsOf(anonRead2.json),
          password_rows_restrictive: rowsOf(pwRead2.json),
        },
      });

      // ---------------- S26c: sb_secret_ with a browser User-Agent; Authorization only.
      if (!secret) {
        out.push({ id: "S26c", title: "sb_secret_ key from a browser", status: "skip", detail: "no secret key on the project" });
      } else {
        const sec = (headers: Record<string, string>) => read(headers);
        const srv = await sec({ apikey: secret, "User-Agent": SERVER_UA });
        const brw = await sec({ apikey: secret, "User-Agent": BROWSER_UA });
        const brwOrigin = await sec({ apikey: secret, "User-Agent": BROWSER_UA, Origin: "https://app.example.com" });
        const srvOrigin = await sec({ apikey: secret, "User-Agent": SERVER_UA, Origin: "https://app.example.com" });
        const bearerOnly = await sec({ Authorization: `Bearer ${secret}`, "User-Agent": SERVER_UA });
        const authBrw = await httpBody(`${base}/auth/v1/admin/users?per_page=1`, { headers: { apikey: secret, Authorization: `Bearer ${secret}`, "User-Agent": BROWSER_UA } });
        const authSrv = await httpBody(`${base}/auth/v1/admin/users?per_page=1`, { headers: { apikey: secret, Authorization: `Bearer ${secret}`, "User-Agent": SERVER_UA } });
        const fmt = (r: { status: number; json: unknown; text: string }) => `${r.status}${r.status >= 400 ? ` ${errCode(r.json, r.text)}` : ""}`;
        out.push({
          id: "S26c",
          title: "sb_secret_ key: browser User-Agent and Origin, and Authorization without apikey",
          status: "info",
          detail: `Data API, secret key in apikey: server UA -> ${fmt(srv)}; browser UA -> ${fmt(brw)}; browser UA + Origin -> ${fmt(brwOrigin)}; server UA + Origin -> ${fmt(srvOrigin)}. Secret key only as Authorization: Bearer, no apikey -> ${fmt(bearerOnly)}. Auth admin list with the secret key: server UA -> ${fmt(authSrv)}; browser UA -> ${fmt(authBrw)}.`,
          measurements: {
            rest_server_ua: srv.status,
            rest_browser_ua: brw.status,
            rest_browser_ua_origin: brwOrigin.status,
            rest_server_ua_origin: srvOrigin.status,
            rest_bearer_only: bearerOnly.status,
            auth_admin_server_ua: authSrv.status,
            auth_admin_browser_ua: authBrw.status,
            browser_refusal_code: brw.status >= 400 ? errCode(brw.json, brw.text).slice(0, 80) : "-",
          },
        });
      }

      // ---------------- S26d: Realtime socket with a foreign Origin.
      const wsUrl = `wss://${p.host}/realtime/v1/websocket?apikey=${p.anon}&vsn=1.0.0`;
      const noOrigin = await wsProbe(wsUrl, {});
      const foreign = await wsProbe(wsUrl, { Origin: "https://attacker.example" });
      out.push({
        id: "S26d",
        title: "Realtime accepts a WebSocket upgrade carrying a foreign Origin",
        status: "info",
        detail: `wss /realtime/v1/websocket with the anon key. No Origin -> opened ${noOrigin.opened}, heartbeat answered ${noOrigin.replied}${noOrigin.closeCode ? `, closed ${noOrigin.closeCode}` : ""}. Origin https://attacker.example -> opened ${foreign.opened}, heartbeat answered ${foreign.replied}${foreign.closeCode ? `, closed ${foreign.closeCode}` : ""}${foreign.error ? `, error ${foreign.error}` : ""}. A socket that opens and answers under a foreign Origin means the hosted endpoint does not enforce check_origin; the anon key and RLS remain the gate.`,
        measurements: {
          no_origin_opened: String(noOrigin.opened),
          no_origin_replied: String(noOrigin.replied),
          foreign_origin_opened: String(foreign.opened),
          foreign_origin_replied: String(foreign.replied),
          foreign_close_code: foreign.closeCode,
        },
      });
    } catch (e) {
      out.push({ id: "S26x", title: "S26 aborted", status: "fail", detail: (e as Error).message.slice(0, 300) });
    } finally {
      if (ref) {
        const d = await deleteProject(ctx, ref);
        out.push({
          id: "S26z",
          title: "Teardown",
          status: d.deleteStatus >= 200 && d.deleteStatus < 300 ? "info" : "fail",
          detail: `DELETE ${d.deleteStatus}, gone from GET /projects after ${d.goneS} s`,
          measurements: { delete_status: d.deleteStatus, gone_s: d.goneS },
        });
      }
    }
    return out;
  },
};
export default mod;
