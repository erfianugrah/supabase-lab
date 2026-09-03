/**
 * S16 - does pgrst.db_pre_request ever fire on the hosted PostgREST, and what
 * x-forwarded-for does the hosted edge hand the database?
 *
 * Managed project, legacy anon JWT as apikey, one micro. iap-lockdown L09 set
 * the role GUC, sent NOTIFY pgrst 'reload config', and saw no fire in 121s.
 * That is one reload path. PostgREST also reads role settings at startup, so a
 * project restart is the second path, and the one L09 never tried.
 *
 *   S16a  request.headers as PostgREST hands them to SQL (an RPC, no
 *         pre-request needed): with a client-supplied
 *         x-forwarded-for=203.0.113.9, does the header reach the DB as the
 *         client value, appended, or replaced? Which address-bearing header
 *         keys are present at all?
 *   S16b  GUC set + NOTIFY reload config: a fire within 60s? (L09 replay)
 *   S16c  POST /projects/{ref}/restart: status, REST observed down, time to
 *         db+rest ACTIVE_HEALTHY, time to REST answering again
 *   S16d  a fire within 180s after the restart?
 *
 * Pass on S16b/S16d means the documented mechanism fired; info means it did
 * not, which is the measured disagreement the doc reports.
 *
 * Not settled by this module: whether a platform-side PostgREST setting (not
 * the role GUC) would enable it; that is not reachable from a customer
 * credential.
 *
 * DESTRUCTIVE: restarts the project (every service down for the window);
 * sets and resets a role GUC; creates a table and two functions, dropped in
 * finally. If S16d fires, the reset only takes effect at the NEXT reload the
 * platform honours, so a later module on the same project could hit a
 * missing pre-request function. Run LAST, alone.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { fetchKeys, httpBody, sql, waitFor } from "../lib/sec.js";

const T = "sec16_seen";
const SPOOF = "203.0.113.9";

interface Shape { keys: string; n: number; hasSpoof: boolean; spoofFirst: boolean }
function shape(json: unknown): Shape {
  const h = json && typeof json === "object" ? (json as Record<string, string>) : {};
  const xff = h["x-forwarded-for"] ?? "";
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    keys: Object.keys(h).filter((k) => /ip|forward|real|client|via/i.test(k)).sort().join(","),
    n: parts.length,
    hasSpoof: parts.includes(SPOOF),
    spoofFirst: parts[0] === SPOOF,
  };
}

const mod: TestModule = {
  id: "S16",
  title: "pre-request on hosted: NOTIFY vs project restart; the x-forwarded-for shape the edge hands SQL",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await fetchKeys(ctx);
    const out: TestResult[] = [];
    const rpc = `https://${ctx.apiHost}/rest/v1/rpc/sec16_headers`;
    const seen = `https://${ctx.apiHost}/rest/v1/${T}?select=xff&order=id.desc&limit=1`;
    const callRpc = (headers: Record<string, string> = {}) => httpBody(rpc, { method: "POST", key: keys.anonJwt, body: {}, headers });
    const fired = async () => {
      await callRpc();
      const r = await httpBody(seen, { key: keys.serviceJwt });
      return r.status === 200 && Array.isArray(r.json) && (r.json as unknown[]).length > 0;
    };
    try {
      await sql(ctx, `
create table if not exists public.${T} (id bigserial primary key, xff text, at timestamptz default now());
grant insert on public.${T} to anon, authenticated;
grant usage, select on sequence public.${T}_id_seq to anon, authenticated;
create or replace function public.sec16_pre() returns void language plpgsql security definer as $$
begin
  insert into public.${T}(xff) values (coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', '<absent>'));
end$$;
grant execute on function public.sec16_pre() to anon, authenticated;
create or replace function public.sec16_headers() returns json language sql stable as $$
  select current_setting('request.headers', true)::json
$$;
grant execute on function public.sec16_headers() to anon, authenticated;
notify pgrst, 'reload schema';
`);
      const ready = await waitFor(async () => (await callRpc()).status === 200, 60_000);
      const plain = await callRpc();
      const spoof = await callRpc({ "x-forwarded-for": SPOOF });
      const p = shape(plain.json);
      const s = shape(spoof.json);
      const verdict = !s.hasSpoof
        ? "REPLACED - the client value is dropped, SQL sees the edge's view only"
        : s.n > p.n
          ? s.spoofFirst
            ? "APPENDED - client value first, then the edge's address"
            : "APPENDED - the edge's address first, then the client value"
          : "PASSED THROUGH - SQL sees only the client value";
      out.push({
        id: "S16a",
        title: "x-forwarded-for as the hosted PostgREST hands it to SQL (client header spoofed)",
        status: plain.status === 200 && spoof.status === 200 ? "pass" : "fail",
        detail: `RPC ready in ${ready.elapsedS}s (HTTP ${plain.status}/${spoof.status}). Without a client header x-forwarded-for carries ${p.n} address(es); with x-forwarded-for=${SPOOF} it carries ${s.n}: ${verdict}. Address-bearing header keys present: ${s.keys || "none"}.`,
        measurements: { rpc_status: spoof.status, xff_addrs_plain: p.n, xff_addrs_spoofed: s.n, spoof_visible: String(s.hasSpoof), spoof_first: String(s.spoofFirst), header_keys: s.keys },
      });

      await sql(ctx, `alter role authenticator set pgrst.db_pre_request to 'public.sec16_pre'; notify pgrst, 'reload config';`);
      const cfg = (await sql(ctx, `select rolconfig from pg_roles where rolname = 'authenticator';`)) as Record<string, unknown>[];
      const gucPersisted = /db_pre_request/.test(JSON.stringify(cfg));
      const afterNotify = await waitFor(fired, 60_000, 5000);
      out.push({
        id: "S16b",
        title: "GUC + NOTIFY reload config: pre-request fires? (L09 replay)",
        status: afterNotify.ok ? "pass" : "info",
        detail: afterNotify.ok
          ? `db_pre_request FIRED ${afterNotify.elapsedS}s after NOTIFY - contradicts L09`
          : `GUC persisted on authenticator: ${gucPersisted}; no pre-request row within ${afterNotify.elapsedS}s of NOTIFY pgrst 'reload config' (matches L09).`,
        measurements: { guc_persisted: String(gucPersisted), fired_after_notify: String(afterNotify.ok), notify_window_s: afterNotify.elapsedS },
      });

      if (!afterNotify.ok) {
        const t0 = Date.now();
        const rs = await mgmt(ctx, "POST", `/projects/${ctx.ref}/restart`);
        const wentDown = await waitFor(async () => (await callRpc()).status !== 200, 120_000, 2000);
        const healthy = await waitFor(async () => {
          const h = await mgmt(ctx, "GET", `/projects/${ctx.ref}/health?services=db&services=rest`);
          const arr = Array.isArray(h.json) ? (h.json as { name: string; status: string }[]) : [];
          return arr.length > 0 && arr.every((x) => x.status === "ACTIVE_HEALTHY");
        }, 300_000, 5000);
        const back = await waitFor(async () => (await callRpc()).status === 200, 300_000, 5000);
        out.push({
          id: "S16c",
          title: "POST /restart: downtime as seen from REST",
          status: rs.status < 300 ? "pass" : "fail",
          detail: `POST /projects/{ref}/restart -> HTTP ${rs.status}. REST observed down: ${wentDown.ok} (at +${wentDown.elapsedS}s); db+rest ACTIVE_HEALTHY at +${healthy.elapsedS}s after that; REST answering again +${back.elapsedS}s after health. Total ${Math.round((Date.now() - t0) / 1000)}s.`,
          measurements: { restart_status: rs.status, rest_down_observed: String(wentDown.ok), down_at_s: wentDown.elapsedS, healthy_after_s: healthy.elapsedS, rest_back_after_s: back.elapsedS, total_s: Math.round((Date.now() - t0) / 1000) },
        });
        const cfg2 = (await sql(ctx, `select rolconfig from pg_roles where rolname = 'authenticator';`)) as Record<string, unknown>[];
        const gucAfter = /db_pre_request/.test(JSON.stringify(cfg2));
        const afterRestart = await waitFor(fired, 180_000, 5000);
        const last = await httpBody(seen, { key: keys.serviceJwt });
        const xffSeen = Array.isArray(last.json) && (last.json as { xff?: string }[])[0]?.xff;
        out.push({
          id: "S16d",
          title: "after a full project restart: pre-request fires?",
          status: afterRestart.ok ? "pass" : "info",
          detail: afterRestart.ok
            ? `db_pre_request FIRED ${afterRestart.elapsedS}s after REST came back. The role GUC is honoured at PostgREST STARTUP, not on NOTIFY: on hosted, a project restart is the activation step L09 lacked. x-forwarded-for in the captured row: ${xffSeen && xffSeen !== "<absent>" ? "present" : "absent"}.`
            : `no pre-request row within ${afterRestart.elapsedS}s after the restart; GUC still on the role: ${gucAfter}. The role-GUC path does not activate on hosted by reload OR by restart.`,
          measurements: { fired_after_restart: String(afterRestart.ok), restart_window_s: afterRestart.elapsedS, guc_after_restart: String(gucAfter), xff_in_row: xffSeen && xffSeen !== "<absent>" ? "present" : "absent" },
        });
      }
    } catch (e) {
      out.push({ id: "S16err", title: "S16 aborted", status: "fail", detail: e instanceof Error ? e.message : String(e) });
    } finally {
      await sql(ctx, `alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';`).catch(() => {});
      await new Promise((r) => setTimeout(r, 8000));
      await sql(ctx, `drop function if exists public.sec16_pre(); drop function if exists public.sec16_headers(); drop table if exists public.${T} cascade; notify pgrst, 'reload schema';`).catch(() => {});
      out.push({ id: "S16z", title: "cleanup", status: "pass", detail: "GUC reset, NOTIFY, table + functions dropped (project is destroyed after this run regardless)" });
    }
    return out;
  },
};
export default mod;
