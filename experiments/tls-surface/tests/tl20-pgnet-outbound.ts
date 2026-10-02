/**
 * TL20 - outbound TLS from inside the database: pg_net.
 *
 * pg_net is libcurl on the database host, with whatever OpenSSL that host
 * ships; this measures what it actually offers (howsmyssl echo) and
 * what it refuses: legacy protocol versions, weak suites, and every
 * certificate failure (expired, self-signed, untrusted root, wrong host,
 * revoked). A pg_net that connects to `expired` or `wrong_host` does not
 * verify certificates - that is a security finding.
 *
 * Each target is one `net.http_get`, collected from `net._http_response`.
 * The orchestrator's curl runs the same list as the control. DESTRUCTIVE:
 * creates the pg_net extension if absent (left installed; the project is
 * disposable).
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { sleep } from "../../medium-serverless/lib/setup";
import { OUTBOUND, summariseHowsMySsl, verdict } from "../lib/outbound";
import { curl } from "../lib/tls";

async function q(ctx: Ctx, sql: string): Promise<{ ok: boolean; rows: Record<string, unknown>[]; text: string }> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/database/query`, { query: sql });
  return { ok: r.status < 300, rows: Array.isArray(r.json) ? (r.json as Record<string, unknown>[]) : [], text: r.text.slice(0, 400) };
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const mod: TestModule = {
  id: "TL20",
  title: "Outbound TLS from pg_net: what it offers, and whether it refuses bad protocols, suites and certificates",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx) {
    const ext = await q(ctx, "create extension if not exists pg_net; select extversion from pg_extension where extname = 'pg_net'");
    if (!ext.ok) return [{ id: "TL20", title: mod.title, status: "fail", detail: `pg_net unavailable: ${ext.text}` }];
    const version = String(ext.rows[0]?.extversion ?? "?");
    const ids: Record<string, number> = {};
    for (const t of OUTBOUND) {
      const r = await q(ctx, `select net.http_get(url := ${lit(t.url)}, timeout_milliseconds := 15000) as id`);
      ids[t.id] = Number(r.rows[0]?.id ?? -1);
    }
    // pg_net's worker processes the queue asynchronously; wait for every row.
    const idList = Object.values(ids).filter((i) => i >= 0).join(",");
    let rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 20 && idList; i++) {
      await sleep(3000);
      rows = (await q(ctx, `select id, status_code, error_msg, timed_out, left(content, 6000) as content from net._http_response where id in (${idList})`)).rows;
      if (rows.length >= Object.keys(ids).length) break;
    }
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const out: TestResult[] = [];
    const m: Record<string, string | number> = { pg_net: version };
    let mismatches = 0;
    const notes: string[] = [];
    for (const t of OUTBOUND) {
      const r = byId.get(ids[t.id] ?? -1);
      const status = Number(r?.status_code ?? 0);
      const err = String(r?.error_msg ?? (r ? "" : "no response row"));
      const got = verdict(status);
      const ctl = await curl({ url: t.url, maxTimeS: 10 });
      const ctlGot = verdict(ctl.code);
      if (got !== t.expect) mismatches++;
      m[t.id] = status ? `${status}` : `fail: ${err.slice(0, 70)}`;
      m[`${t.id}_control`] = ctl.code ? `${ctl.code}` : `fail: ${ctl.err.slice(0, 50)}`;
      notes.push(`${t.id}: pg_net ${got}${status ? ` ${status}` : ` (${err.slice(0, 80)})`}, expected ${t.expect}, control ${ctlGot}`);
      if (t.id === "howsmyssl" && status === 200) Object.assign(m, summariseHowsMySsl(String(r?.content ?? "")));
    }
    out.push({
      id: "TL20",
      title: mod.title,
      status: mismatches ? "fail" : "pass",
      detail: `pg_net ${version}; ${mismatches} target(s) where pg_net differs from a verifying modern client. ${notes.join("; ")}`,
      measurements: { mismatches, ...m },
    });
    return out;
  },
};
export default mod;
