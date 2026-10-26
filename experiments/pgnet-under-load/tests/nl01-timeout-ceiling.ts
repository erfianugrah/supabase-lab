/**
 * NL01 - pg_net's per-call timeout and its ceiling, on the hosted version.
 *
 * Question: what does `timeout_milliseconds` do on hosted pg_net, is there a
 * ceiling (the upstream README at HEAD documents `pg_net.max_timeout_ms`,
 * default 600000), and does a call that the receiver answers after 30 s or
 * 90 s complete when the timeout allows it?
 *
 * One fresh Pro-org Micro (shared with NL02). Reads the extension version,
 * every `pg_net%` setting, `show pg_net.max_timeout_ms` and the signature of
 * net.http_post. Then enqueues net.http_post to the receiver's /sleep?ms=N for
 * N in 4, 8, 30, 90 s against timeout_milliseconds 5000, 30000, 120000,
 * 600000, 600001, 0 and the SQL default (argument omitted), each enqueue in
 * its own statement so a refused value is recorded rather than aborting the
 * rest, and reads net._http_response (status_code, timed_out, error_msg).
 * All accepted calls are in flight together; the receiver ledger records the
 * arrival of every one.
 *
 * Side check (NL01t): whether `select count(*) from generate_series(1, N)`
 * writes temp files (FunctionScan materialises an SRF into a tuplestore),
 * which decides the CPU-burn query NL03/NL04 use.
 *
 * Needs PVLAB_ORG_PRO and PVLAB_ENDPOINT_RECEIVER. DESTRUCTIVE: creates a project.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { ensureProject, errText, ledger, phases, scrub, skipWithout, sql, sqlOk, waitResponses } from "../lib/nl.js";

const SLEEPS = [4_000, 8_000, 30_000, 90_000];
const TMOS: (number | null)[] = [5_000, 30_000, 120_000, 600_000, 600_001, 0, null];

const mod: TestModule = {
  id: "NL01",
  title: "pg_net timeout_milliseconds: ceiling, default, long calls",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithout(ctx, "NL01", this.title);
    if (skip) return skip;
    const results: TestResult[] = [];
    try {
      const p = await ensureProject(ctx, "micro");
      const recv = ctx.endpoints.receiver ?? "";
      const ver = await sqlOk(ctx, p.ref, "select extversion from pg_extension where extname = 'pg_net'");
      const settings = await sqlOk(ctx, p.ref, "select name, setting, unit, boot_val, context from pg_settings where name like 'pg_net%' order by name");
      const show = await sql(ctx, p.ref, "show pg_net.max_timeout_ms");
      const sig = await sqlOk(ctx, p.ref, "select p.proname, pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net' and p.proname in ('http_post', 'http_get') order by 1");
      const workers = await sqlOk(ctx, p.ref, "select backend_type, state, wait_event_type, wait_event from pg_stat_activity where backend_type ilike '%net%'");
      const postSig = String(sig.find((r) => r.proname === "http_post")?.args ?? "");
      const tmoDefault = /timeout_milliseconds integer DEFAULT (\d+)/.exec(postSig)?.[1] ?? "?";
      results.push({
        id: "NL01a",
        title: "hosted pg_net version, settings and http_post signature",
        status: "info",
        detail: `${p.pgVersion}; pg_net ${ver[0]?.extversion}; settings: ${settings.map((s) => `${s.name}=${s.setting}${s.unit ? s.unit : ""}`).join(", ")}; show pg_net.max_timeout_ms -> ${show.error ? `ERROR ${show.error}` : JSON.stringify(show.rows[0])}; http_post timeout_milliseconds default ${tmoDefault}; worker backends: ${workers.map((w) => `${w.backend_type} (${w.state ?? ""} ${w.wait_event_type ?? ""}/${w.wait_event ?? ""})`).join("; ")}`,
        measurements: {
          pg_net_version: String(ver[0]?.extversion ?? ""),
          max_timeout_ms_setting: show.error ? "absent" : String(Object.values(show.rows[0] ?? {})[0] ?? ""),
          http_post_timeout_default_ms: tmoDefault,
          batch_size: String(settings.find((s) => s.name === "pg_net.batch_size")?.setting ?? "absent"),
          settings_n: settings.length,
          create_s: p.createS,
        },
        evidence: JSON.stringify({ settings, sig, workers }).slice(0, 3000),
      });

      // The matrix: one statement per call so a refused timeout is a recorded error, not an aborted run.
      const run = `nl01-${Date.now()}`;
      const refused: Record<string, string> = {};
      for (const s of SLEEPS) {
        for (const t of TMOS) {
          const tag = `s${s}-t${t ?? "default"}`;
          const r = await sql(ctx, p.ref, `select public.nl_post('${run}', '${tag}', 'sleep', '${recv}/sleep?ms=${s}', ${t === null ? "null" : t}) as id`);
          if (r.error) refused[tag] = r.error;
        }
      }
      const rows = await waitResponses(ctx, p.ref, run, 300_000);
      const led = await ledger(ctx, run);
      const arrived = new Map<number, number>();
      for (const l of led) arrived.set(l.id, l.arr_ms);

      const cell: Record<string, string> = {};
      const lines: string[] = [];
      for (const s of SLEEPS) {
        for (const t of TMOS) {
          const tag = `s${s}-t${t ?? "default"}`;
          if (refused[tag]) {
            cell[tag] = "refused";
            continue;
          }
          const r = rows.find((x) => x.tag === tag);
          if (!r) { cell[tag] = "no-call-row"; continue; }
          const enq = Number(r.enq_ms);
          const ar = arrived.get(Number(r.id));
          const respAfter = r.resp_ms ? Number(r.resp_ms) - enq : -1;
          if (!r.has_resp) cell[tag] = "no-response";
          else if (r.timed_out) cell[tag] = `timed_out (row created ${respAfter} ms after enqueue)`;
          else if (r.status_code) cell[tag] = `${r.status_code} (row created ${respAfter} ms after enqueue)`;
          else cell[tag] = `error ${String(r.error_msg ?? "").slice(0, 80)} (row created ${respAfter} ms after enqueue)`;
          if (ar === undefined) cell[tag] += ", never arrived";
        }
        lines.push(`sleep ${s / 1000} s: ${TMOS.map((t) => `t=${t ?? "default"} ${cell[`s${s}-t${t ?? "default"}`]}`).join("; ")}`);
      }
      const timeoutMsgs = rows.filter((r) => r.timed_out || r.error_msg).map((r) => ({ tag: r.tag, err: String(r.error_msg ?? ""), phases: phases(String(r.error_msg ?? "")) }));
      const refusedText = Object.entries(refused).map(([k, v]) => `${k}: ${v}`);
      // Hypothesis: completes iff sleep < timeout for 0 < t <= 600000.
      const longOk = cell["s90000-t120000"]?.startsWith("200") && cell["s30000-t120000"]?.startsWith("200");
      results.push({
        id: "NL01b",
        title: "timeout matrix: receiver sleep x timeout_milliseconds",
        status: "info",
        detail: `${lines.join(" | ")}. Refused at enqueue: ${refusedText.length ? scrub(ctx, refusedText.join("; ")).slice(0, 600) : "none"}. Calls past 30 s and 90 s completed when allowed: ${longOk ? "yes" : "no"}. ${led.length} arrivals recorded by the receiver for ${rows.length} accepted calls.`,
        measurements: Object.fromEntries([
          ...Object.entries(cell).map(([k, v]) => [k, v]),
          ["run", run],
          ["calls_accepted", rows.length],
          ["calls_refused", Object.keys(refused).length],
          ["receiver_arrivals", led.length],
        ]),
        evidence: scrub(ctx, JSON.stringify({ refused, timeoutMsgs: timeoutMsgs.slice(0, 12) })).slice(0, 3500),
      });

      // NL01t: does a FROM-clause generate_series spill to temp files?
      const ex = async (q: string) => {
        const r = await sqlOk(ctx, p.ref, `explain (analyze, buffers, format json) ${q}`);
        const plan = JSON.stringify(r[0] ?? {});
        const tw = [...plan.matchAll(/"Temp Written Blocks":\s*(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
        const ms = Number(/"Execution Time":\s*([\d.]+)/.exec(plan)?.[1] ?? -1);
        return { tw, ms };
      };
      const from = await ex("select count(*) from generate_series(1, 5000000)");
      const tl = await ex("select count(*) from (select generate_series(1, 5000000)) s");
      const wm = await sqlOk(ctx, p.ref, "show work_mem");
      results.push({
        id: "NL01t",
        title: "side check: generate_series in FROM vs in the target list, temp blocks written",
        status: "info",
        detail: `work_mem ${Object.values(wm[0] ?? {})[0]}; count(*) over generate_series(1, 5e6) in FROM: ${from.tw} temp blocks written, ${from.ms} ms; in the target list: ${tl.tw} temp blocks, ${tl.ms} ms. The NL03/NL04 burners spin a PL/pgSQL loop instead.`,
        measurements: { from_temp_blocks: from.tw, from_ms: from.ms, targetlist_temp_blocks: tl.tw, targetlist_ms: tl.ms },
      });
    } catch (e) {
      results.push({ id: "NL01err", title: "NL01 aborted", status: "fail", detail: scrub(ctx, errText(e)) });
    }
    return results;
  },
};
export default mod;
