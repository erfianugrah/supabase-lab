/**
 * TL04 - everything around the handshake on the HTTP edge: SNI, ALPN, HTTP
 * versions, HSTS, and plaintext port 80.
 *
 *   SNI    no SNI at all, and an unknown name (`.invalid`, never a real
 *          domain - a real one may itself be on the same edge) sent to the
 *          project's edge address: refused, or served with which cert.
 *          Clients without SNI are the other EOL-device failure mode.
 *   ALPN   offer h2,http/1.1 then http/1.1 only: what the edge picks.
 *   HTTP/3 curl --http3-only, with cloudflare.com as a vantage control: if
 *          the control also fails, UDP/443 is blocked HERE and the row says
 *          so instead of reporting "no HTTP/3".
 *   HSTS   the Strict-Transport-Security header per name, verbatim.
 *   :80    plain HTTP to /auth/v1/health and a Storage route: redirect,
 *          refusal, served in the clear, or a hang after the client has
 *          already sent its headers in the clear (what a pen tester flags).
 *
 * Read-only.
 */
import { $ } from "bun";
import type { TestModule, TestResult } from "../../../harness/src/types";
import { curl, edgeTargets, handshake, type Target } from "../lib/tls";

export async function edgeExtrasRows(prefix: string, targets: Target[], anonKey?: string): Promise<TestResult[]> {
  const out: TestResult[] = [];
  const h3Control = await curl({ url: "https://cloudflare.com/cdn-cgi/trace", http: "3only", maxTimeS: 8 });
  const udpOk = h3Control.code > 0;
  for (const t of targets) {
    const ip = t.connect ?? (await $`dig +short ${t.host} A`.quiet().nothrow()).stdout.toString().trim().split("\n").filter((l) => /^\d+\./.test(l)).pop() ?? "";
    if (!ip) {
      out.push({ id: `${prefix}-${t.role}`, title: `${t.host}: SNI, ALPN, HTTP versions, HSTS, port 80`, status: "info", detail: "name does not resolve from here" });
      continue;
    }
    const pinned = { ...t, connect: ip };
    const noSni = await handshake(pinned, { sni: null });
    const foreign = await handshake(pinned, { sni: "tl04-unknown.invalid" });
    const alpnBoth = await handshake(pinned, { alpn: "h2,http/1.1" });
    const alpn11 = await handshake(pinned, { alpn: "http/1.1" });
    const pin = t.connect ? { host: t.host, ip: t.connect } : undefined;
    const path = t.role === "mgmt" ? "/v1/projects" : "/auth/v1/health";
    const headers = anonKey && t.role !== "mgmt" ? [`apikey: ${anonKey}`] : [];
    const h2 = await curl({ url: `https://${t.host}${path}`, pin, headers });
    const h3 = await curl({ url: `https://${t.host}${path}`, pin, headers, http: "3only", maxTimeS: 8 });
    // Port 80 on two routes: the health path, and a Storage route (the first
    // run found the Storage host serves a gateway 404 in cleartext on one
    // and hangs with no answer on the other - never a redirect).
    const plainNote = async (p: string) => {
      const t0 = Date.now();
      const r = await curl({ url: `http://${t.host}${p}`, headers, maxTimeS: 8, pin: pin && { ...pin, port: 80 } });
      const gw = r.headers["sb-gateway-version"] ? " from the project gateway" : "";
      return r.code ? `HTTP ${r.code}${r.headers.location ? ` -> ${r.headers.location}` : gw}` : Date.now() - t0 >= 7500 ? "no answer in 8s (request already sent in cleartext)" : `no answer (${r.err || `exit ${r.exit}`})`;
    };
    const plainHealth = await plainNote(path);
    const plainStorage = t.role === "mgmt" ? "n/a" : await plainNote("/storage/v1/version");
    const m: Record<string, string | number> = {
      no_sni: noSni.ok ? `ok ${noSni.subject.replace(/^CN=/, "")}` : noSni.outcome,
      foreign_sni: foreign.ok ? `ok ${foreign.subject.replace(/^CN=/, "")}` : foreign.outcome,
      alpn_h2_h11: alpnBoth.alpn || "none",
      alpn_h11_only: alpn11.alpn || "none",
      http_default: h2.httpVersion,
      http3: h3.code ? `HTTP ${h3.code} via ${h3.httpVersion}` : udpOk ? "no" : "vantage-blocks-udp",
      alt_svc: h2.headers["alt-svc"] ?? "none",
      hsts: h2.headers["strict-transport-security"] ?? "none",
      port80: plainHealth,
      port80_storage: plainStorage,
    };
    out.push({
      id: `${prefix}-${t.role}`,
      title: `${t.host}: SNI, ALPN, HTTP versions, HSTS, port 80`,
      status: "info",
      detail: Object.entries(m).map(([k, v]) => `${k}=${v}`).join("; "),
      measurements: m,
    });
  }
  out.push({ id: `${prefix}-vantage`, title: "vantage control: HTTP/3 to cloudflare.com", status: "info", detail: udpOk ? `HTTP/3 works from here (HTTP ${h3Control.code})` : `HTTP/3 fails from here too (${h3Control.err}) - HTTP/3 rows are not measurements of the edge`, measurements: { udp443: udpOk ? "ok" : "blocked" } });
  return out;
}

const mod: TestModule = {
  id: "TL04",
  title: "HTTP edge: SNI, ALPN, HTTP/2 and HTTP/3, HSTS, plaintext port 80",
  where: "local",
  requires: ["openssl"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL04", title: mod.title, status: "skip", detail: "no project ref" }];
    return edgeExtrasRows("TL04", await edgeTargets(ctx), ctx.anonKey);
  },
};
export default mod;
