/**
 * LV01 - how many log rows, and how many bytes of queryable log content, does
 * one client action produce on a default project, per log source?
 *
 * One throwaway Pro-org project (ap-southeast-1), default settings. Vantage:
 * this machine. Keys: legacy anon key for REST GETs, Edge Functions and
 * Realtime; legacy service_role key for REST inserts and Storage setup; no key
 * for the public Storage reads; a password-signed-in user (ES256 access token
 * on a new project) for the Auth rows. Every phase is sequential, separated by
 * a quiet gap, and runs in its own time window; per-action figures are the
 * window's rows minus the idle rate (LV01a) times the window length, divided
 * by the action count (Edge Function phases: see LV01e). Size is the proxy in
 * lib/lv.ts, not metered bytes.
 *
 *   LV01a  idle: no client traffic for IDLE_S seconds after setup (which
 *          invokes each Edge Function once); rows and bytes per second per
 *          source, extrapolated per hour and per day. Late Shutdown rows from
 *          the setup invocations can land in this window.
 *   LV01b  REST GET, anon key, N requests (marker in the query string).
 *   LV01c  REST insert, service_role key: N single-row POSTs.
 *   LV01d  REST insert, service_role key: one POST carrying N rows.
 *   LV01e  Edge Function, N invocations, no console output. The Edge Function
 *          phases run last; `function_logs` for them is counted by function_id
 *          from the phase start to read-back (after a 5-minute tail), because
 *          Shutdown rows can land minutes after the request
 *          (`ef_total_*` = function_logs by id + function_edge_logs in window).
 *   LV01f  Edge Function, N invocations, one ~100-character console.log each.
 *   LV01g  Edge Function, N invocations, ten console.log lines each.
 *   LV01h  supabase-js auth.getUser(), N calls, signed-in user.
 *   LV01i  supabase-js auth.getClaims(), N calls, same user (ES256 token, so
 *          verification is local against a cached JWKS per the docs).
 *   LV01j  Storage public object, the same 1 KB object fetched N times with no
 *          query string; cf-cache-status recorded per response.
 *   LV01k  Realtime: one subscriber and one sender on a broadcast channel,
 *          N broadcast messages over the open websocket (no HTTP per message).
 *   LV01l  Realtime: the same two clients subscribed and idle for IDLE_S.
 *
 * Pass/fail: none; every row is `info`. Not settled: metered bytes (not
 * readable by PAT), other regions, sampling under load, Dashboard queries,
 * log drains, platform-side trimming that lands after the run date.
 *
 * DESTRUCTIVE: creates and deletes one project; runs about 25-28 minutes.
 */
import { createClient } from "@supabase/supabase-js";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { deployViaApi } from "../../edge-function-limits/lib/ef";
import { dropProject, makeProject, sleep, sql } from "../../observability-surface/lib/ob";
import { PREFIX, type Window, footprint, hist, logsTypes, markerFootprint, perAction, rates, sendN, waitForRows } from "../lib/lv";

const N = Number(process.env.LV01_N ?? 100);
const IDLE_S = Number(process.env.LV01_IDLE_S ?? 180);
const GAP_MS = 30_000;
// Window padding: event timestamps can sit a little either side of the client's send loop.
const PAD_BEFORE = 1000;
const PAD_AFTER = 5000;
const LINE = "lv01 " + "x".repeat(95);

const fn = (lines: number) =>
  lines === 0
    ? `Deno.serve(() => new Response("ok"));`
    : `Deno.serve(() => { for (let i = 0; i < ${lines}; i++) console.log(${JSON.stringify(LINE)} + i); return new Response("ok"); });`;

const mod: TestModule = {
  id: "LV01",
  title: "Log rows and bytes per client action, by source",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.orgs.pro) return [{ id: "LV01", title: this.title, status: "skip", detail: "PVLAB_ORG_PRO not set" }];
    const out: TestResult[] = [];
    let ref = "";
    try {
      const proj = await makeProject(ctx, "lv01", PREFIX);
      ref = proj.ref;
      const pc = proj.ctx;
      const url = `https://${pc.apiHost}`;
      const anon = { apikey: pc.anonKey!, authorization: `Bearer ${pc.anonKey}` };
      const svc = { apikey: pc.serviceKey!, authorization: `Bearer ${pc.serviceKey}` };
      const run = Date.now().toString(36);

      // ---- setup (outside every window)
      const ddl = await sql(
        pc,
        "create table public.lv(id bigserial primary key, v text); alter table public.lv enable row level security; create policy lv_read on public.lv for select to anon using (true); insert into public.lv(v) values ('seed');",
      );
      if (ddl.status >= 300) throw new Error(`ddl: ${ddl.error}`);
      const fnIds: Record<string, string> = {};
      for (const [slug, lines] of [["lv-silent", 0], ["lv-one", 1], ["lv-ten", 10]] as const) {
        const d = await deployViaApi(pc, slug, [{ name: "index.ts", content: fn(lines) }], { entrypoint_path: "index.ts", name: slug, verify_jwt: false });
        if (d.status >= 300) throw new Error(`deploy ${slug} HTTP ${d.status} ${d.error}`);
        fnIds[slug] = String((d.json as { id?: string } | undefined)?.id ?? "");
        for (let i = 0; i < 20; i++) {
          const r = await fetch(`${url}/functions/v1/${slug}`, { headers: anon }).catch(() => null);
          await r?.arrayBuffer();
          if (r?.status === 200) break;
          await sleep(3000);
        }
      }
      const admin = createClient(url, pc.serviceKey!, { auth: { persistSession: false } });
      const email = `lv01-${run}@example.com`;
      const cu = await admin.auth.admin.createUser({ email, password: "Passw0rd!lv01", email_confirm: true });
      if (cu.error) throw new Error(`createUser: ${cu.error.message}`);
      const user = createClient(url, pc.anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
      const si = await user.auth.signInWithPassword({ email, password: "Passw0rd!lv01" });
      if (si.error || !si.data.session) throw new Error(`signIn: ${si.error?.message}`);
      const alg = JSON.parse(Buffer.from(si.data.session.access_token.split(".")[0]!, "base64url").toString()).alg as string;
      const bucket = `lv${run}`;
      await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...svc, "content-type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: true }) }).then((r) => r.arrayBuffer());
      const up = await fetch(`${url}/storage/v1/object/${bucket}/a.txt`, { method: "POST", headers: { ...svc, "content-type": "text/plain" }, body: "y".repeat(1024) });
      await up.arrayBuffer();
      if (up.status >= 300) throw new Error(`storage upload HTTP ${up.status}`);
      await sleep(GAP_MS);

      // ---- phases
      const windows: Window[] = [];
      const notes: Record<string, string> = {};
      const phase = async (name: string, n: number, body: () => Promise<string | void>) => {
        const t0 = Date.now();
        const note = await body();
        const t1 = Date.now();
        windows.push({ name, t0, t1, n, note: note ?? undefined });
        if (note) notes[name] = note;
        await sleep(GAP_MS);
      };

      await phase("idle", 1, async () => {
        await sleep(IDLE_S * 1000);
      });
      await phase("rest_get", N, async () => hist(await sendN(N, (i) => fetch(`${url}/rest/v1/lv?select=id&v=neq.lvg${run}-${i}`, { headers: anon }))));
      await phase("rest_insert_single", N, async () =>
        hist(await sendN(N, (i) => fetch(`${url}/rest/v1/lv`, { method: "POST", headers: { ...svc, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ v: `lvs${run}-${i}` }) }))),
      );
      await phase("rest_insert_bulk", 1, async () => {
        const rows = Array.from({ length: N }, (_, i) => ({ v: `lvb${run}-${i}` }));
        return hist(await sendN(1, () => fetch(`${url}/rest/v1/lv`, { method: "POST", headers: { ...svc, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(rows) })));
      });
      await phase("auth_getuser", N, async () => {
        let ok = 0;
        for (let i = 0; i < N; i++) if (!(await user.auth.getUser()).error) ok++;
        return `ok:${ok}`;
      });
      await phase("auth_getclaims", N, async () => {
        let ok = 0;
        for (let i = 0; i < N; i++) if (!(await user.auth.getClaims()).error) ok++;
        return `ok:${ok} alg:${alg}`;
      });
      const cache: Record<string, number> = {};
      await phase("storage_public_get", N, async () => {
        for (let i = 0; i < N; i++) {
          const r = await fetch(`${url}/storage/v1/object/public/${bucket}/a.txt`).catch(() => null);
          await r?.arrayBuffer();
          const k = `${r?.status ?? 0}/${r?.headers.get("cf-cache-status") ?? "none"}`;
          cache[k] = (cache[k] ?? 0) + 1;
        }
        return Object.entries(cache)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ");
      });

      // Realtime: connect both clients outside the windows, then measure messages and idle separately.
      const rx = createClient(url, pc.anonKey!, { auth: { persistSession: false } });
      const tx = createClient(url, pc.anonKey!, { auth: { persistSession: false } });
      let received = 0;
      const topic = `lv${run}`;
      const chRx = rx.channel(topic).on("broadcast", { event: "m" }, () => {
        received++;
      });
      const chTx = tx.channel(topic);
      const subscribed = (ch: ReturnType<typeof rx.channel>) =>
        new Promise<string>((resolve) => {
          const t = setTimeout(() => resolve("timeout"), 20_000);
          ch.subscribe((s) => {
            if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
              clearTimeout(t);
              resolve(s);
            }
          });
        });
      const subs = `${await subscribed(chRx)}/${await subscribed(chTx)}`;
      await sleep(GAP_MS);
      await phase("realtime_broadcast", N, async () => {
        for (let i = 0; i < N; i++) await chTx.send({ type: "broadcast", event: "m", payload: { i, m: `lvr${run}` } });
        await sleep(3000);
        return `subscribe:${subs} received:${received}`;
      });
      await phase("realtime_idle", 1, async () => {
        await sleep(IDLE_S * 1000);
        return `subscribe:${subs}`;
      });
      await rx.removeAllChannels();
      await tx.removeAllChannels();
      await sleep(GAP_MS);

      // Edge Functions last: each invocation writes a Boot row at once and a
      // Shutdown row up to a few minutes later, which would spill into any
      // phase that followed. Their function_logs are counted by function_id
      // from the phase start to the end of the tail instead of by window.
      for (const [name, slug] of [["ef_silent", "lv-silent"], ["ef_one_log", "lv-one"], ["ef_ten_logs", "lv-ten"]] as const) {
        await phase(name, N, async () => hist(await sendN(N, (i) => fetch(`${url}/functions/v1/${slug}?m=lve${run}-${i}`, { headers: anon }))));
      }

      // ---- read back: wait for the marker phases to land completely, then a tail for the rest
      const restRows = await waitForRows(pc, windows[0]!.t0, `lvg${run}`, N);
      await sleep(300_000);

      const idleW = windows.find((w) => w.name === "idle")!;
      const idleF = await footprint(pc, idleW.t0, idleW.t1);
      const idleRate = rates(idleF.counts, (idleW.t1 - idleW.t0) / 1000);
      out.push({
        id: "LV01a",
        title: "LV01a: idle project, rows and bytes per hour by source",
        status: idleF.error ? "fail" : "info",
        detail: idleF.error || undefined,
        measurements: Object.fromEntries([
          ["window_s", Math.round((idleW.t1 - idleW.t0) / 1000)],
          ...[...idleRate.entries()].flatMap(([s, r]) => [
            [`${s}_rows_per_hour`, Math.round(r.rows * 3600)],
            [`${s}_kb_per_hour`, Math.round((r.bytes * 3600) / 1024)],
          ]),
          ["all_sources_mb_per_day", Math.round(([...idleRate.values()].reduce((a, r) => a + r.bytes, 0) * 86400) / 1024 / 1024 * 10) / 10],
        ]),
      });

      const ids: Record<string, string> = {
        rest_get: "LV01b",
        rest_insert_single: "LV01c",
        rest_insert_bulk: "LV01d",
        ef_silent: "LV01e",
        ef_one_log: "LV01f",
        ef_ten_logs: "LV01g",
        auth_getuser: "LV01h",
        auth_getclaims: "LV01i",
        storage_public_get: "LV01j",
        realtime_broadcast: "LV01k",
        realtime_idle: "LV01l",
      };
      for (const w of windows.filter((x) => x.name !== "idle")) {
        const f = await footprint(pc, w.t0 - PAD_BEFORE, w.t1 + PAD_AFTER);
        const m = perAction({ ...w, t0: w.t0 - PAD_BEFORE, t1: w.t1 + PAD_AFTER }, f.counts, idleRate);
        if (w.note) m.client_note = w.note;
        const slug = ({ ef_silent: "lv-silent", ef_one_log: "lv-one", ef_ten_logs: "lv-ten" } as Record<string, string>)[w.name];
        if (slug && fnIds[slug]) {
          // all function_logs rows for this function from phase start to now, by event type
          const byType = await footprint(pc, w.t0 - PAD_BEFORE, Date.now(), `source = 'function_logs' and log_attributes['function_id'] = '${fnIds[slug]}'`);
          const ft = await logsTypes(pc, w.t0 - PAD_BEFORE, fnIds[slug]);
          const fl = byType.counts[0] ?? { rows: 0, bytes: 0 };
          m.function_logs_by_id_rows_per_action = Math.round((fl.rows / w.n) * 100) / 100;
          m.function_logs_by_id_bytes_per_action = Math.round(fl.bytes / w.n);
          m.function_logs_by_id_event_types = ft;
          const fe = f.counts.find((c) => c.source === "function_edge_logs") ?? { rows: 0, bytes: 0 };
          m.ef_total_rows_per_action = Math.round(((fl.rows + fe.rows) / w.n) * 100) / 100;
          m.ef_total_bytes_per_action = Math.round((fl.bytes + fe.bytes) / w.n);
        }
        if (w.name === "rest_get") {
          m.marker_rows_at_end_of_run = await waitForRows(pc, windows[0]!.t0, `lvg${run}`, N, 1000);
          const mk = await markerFootprint(pc, w.t0 - PAD_BEFORE, w.t1 + PAD_AFTER, `lvg${run}`);
          const e = mk.counts.find((c) => c.source === "edge_logs");
          m.marker_rows_in_edge_logs = e?.rows ?? 0;
          m.marker_bytes_per_edge_row = e && e.rows ? Math.round(e.bytes / e.rows) : 0;
          m.marker_rows_seen_before_tail = restRows;
        }
        out.push({ id: ids[w.name] ?? w.name, title: `${ids[w.name]}: ${w.name}`, status: f.error ? "fail" : "info", detail: f.error || undefined, measurements: m });
        await sleep(3000);
      }
    } catch (e) {
      out.push({ id: "LV01", title: "LV01", status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await dropProject(ctx, ref);
    }
    return out;
  },
};
export default mod;
