/**
 * TL05 - an EOL client that offers ONLY the four ECDHE CBC SHA-2 suites,
 * calling every service route a project exposes.
 *
 * TL02 says whether the edge accepts a suite; this says what an application
 * on such a client actually gets, per route: Auth, the Data API, Storage
 * REST, Edge Functions, a Realtime WebSocket upgrade, and - for
 * `.supabase.co` hosts only - the S3 endpoint on `<ref>.storage.supabase.co`. Each route is called twice with curl - once restricted to
 * TLS <= 1.2 with only those four suites, once unrestricted as the
 * control - and the negotiated suite is read from curl's trace, so "it
 * worked" is tied to the cipher that was actually used.
 *
 * Each leg's status and negotiated suite are columns, so `pvlab --diff`
 * between two runs shows any per-route change; a failed leg records curl's
 * error text, which is what a client limited to these suites would log.
 * Read-only.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { ECDHE_CBC_SHA2, curl } from "../lib/tls";

export interface Route {
  name: string;
  url: string;
  headers: string[];
  http?: "1.1";
}

export function routes(host: string, ref: string, anon: string): Route[] {
  const key = anon ? [`apikey: ${anon}`] : [];
  const wsKey = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  return [
    { name: "auth", url: `https://${host}/auth/v1/health`, headers: key },
    { name: "rest", url: `https://${host}/rest/v1/`, headers: key },
    { name: "storage", url: `https://${host}/storage/v1/bucket`, headers: key },
    { name: "functions", url: `https://${host}/functions/v1/tl05-absent`, headers: key },
    { name: "realtime_ws", url: `https://${host}/realtime/v1/websocket?apikey=${anon}&vsn=1.0.0`, headers: ["Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${wsKey}`], http: "1.1" },
    ...(host.endsWith(".supabase.co") ? [{ name: "storage_s3", url: `https://${ref}.storage.supabase.co/storage/v1/s3`, headers: [] }] : []),
  ];
}

export async function cbcClientRows(prefix: string, host: string, ref: string, anon: string, pin?: { host: string; ip: string }): Promise<TestResult[]> {
  const out: TestResult[] = [];
  const m: Record<string, string | number> = {};
  const notes: string[] = [];
  let mismatch = 0;
  for (const r of routes(host, ref, anon)) {
    const usePin = pin && r.url.includes(pin.host) ? pin : undefined;
    const ctl = await curl({ url: r.url, headers: r.headers, http: r.http, pin: usePin, maxTimeS: 10 });
    const cbc = await curl({ url: r.url, headers: r.headers, http: r.http, pin: usePin, maxTimeS: 10, tlsMax: "1.2", ciphers: ECDHE_CBC_SHA2.join(":") });
    const show = (x: typeof ctl) => (x.code ? `HTTP ${x.code} over ${x.tls || "?"}` : `FAILED ${x.err || `curl exit ${x.exit}`}`);
    m[`control_${r.name}`] = ctl.code || `exit${ctl.exit}`;
    m[`cbc_${r.name}`] = cbc.code ? cbc.code : `fail:${cbc.err.replace(/^.*SSL routines::/, "").slice(0, 60) || `exit${cbc.exit}`}`;
    m[`cbc_${r.name}_suite`] = cbc.tls.split(" / ")[1] ?? "-";
    if (ctl.code !== cbc.code) mismatch++;
    notes.push(`${r.name}: control ${show(ctl)}; CBC-only ${show(cbc)}`);
  }
  out.push({
    id: prefix,
    title: `${host}: every service route from a client offering only the four ECDHE CBC SHA-2 suites`,
    status: "info",
    detail: `${mismatch ? `${mismatch} route(s) answer differently over CBC. ` : "CBC-only client gets the same answers as the control on every route. "}${notes.join("; ")}`,
    measurements: { routes_differing: mismatch, ...m },
  });
  return out;
}

const mod: TestModule = {
  id: "TL05",
  title: "CBC-only client: every service route, against an unrestricted control",
  where: "local",
  requires: ["anon-key"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL05", title: mod.title, status: "skip", detail: "no project ref" }];
    return cbcClientRows("TL05", ctx.apiHost, ctx.ref, ctx.anonKey ?? "");
  },
};
export default mod;
