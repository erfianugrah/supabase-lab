/**
 * TLS probing shared by the tls-surface modules.
 *
 * Everything here drives the openssl and curl binaries rather than a TLS
 * library, for two reasons. A client library negotiates what IT supports and
 * hides the rest, so it cannot answer "does the server accept cipher X" for a
 * cipher the library has dropped; and the evidence a customer's security team
 * re-runs is `openssl s_client`, so the lab's evidence should be the same
 * command line. The parsers are pure and unit tested against real output
 * captured on 2026-10-02 (lib/tls.test.ts).
 *
 * The one rule the helpers enforce: a handshake the CLIENT could not even
 * attempt (OpenSSL 3 refuses to offer TLS 1.0/1.1 or legacy suites at its
 * default security level) is `client-unable`, never a server refusal. Every
 * legacy probe lowers the client to @SECLEVEL=0 so the server's answer is the
 * one recorded. Suites this OpenSSL build does not compile in at all (3DES on
 * 3.6.5) are never offered and appear nowhere - untested, not refused.
 */
import { $ } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../../../harness/src/types";

export type Proto = "1.0" | "1.1" | "1.2" | "1.3";
export const PROTOS: Proto[] = ["1.0", "1.1", "1.2", "1.3"];
const PROTO_FLAG: Record<Proto, string> = { "1.0": "-tls1", "1.1": "-tls1_1", "1.2": "-tls1_2", "1.3": "-tls1_3" };

/** The four ECDHE CBC suites with SHA-2 MACs the project edge offered on 2026-10-02, OpenSSL names. */
export const ECDHE_CBC_SHA2 = [
  "ECDHE-ECDSA-AES128-SHA256",
  "ECDHE-RSA-AES128-SHA256",
  "ECDHE-ECDSA-AES256-SHA384",
  "ECDHE-RSA-AES256-SHA384",
];

/** Every TLS 1.3 suite OpenSSL can offer; the CCM ones are off by default on most servers. */
export const TLS13_SUITES = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_CCM_SHA256",
  "TLS_AES_128_CCM_8_SHA256",
];

/** CBC by construction: not AEAD, not a stream cipher, not NULL, not a TLS 1.3 name. */
export function isCbc(name: string): boolean {
  if (/CBC/.test(name)) return true;
  if (/GCM|CHACHA|CCM|RC4|NULL/.test(name)) return false;
  if (/^TLS_/.test(name)) return false;
  return true;
}

export interface Target {
  /** What the module calls it in measurements: `api`, `storage`, `shared_5432`... */
  role: string;
  host: string;
  port: number;
  /** Connect to this address instead of resolving `host` (SNI and verification still use `host`). */
  connect?: string;
  starttls?: "postgres";
}

export interface HsOpts {
  proto?: Proto;
  cipher?: string;
  suites?: string;
  /** undefined = target host; null = send no SNI at all; string = that name. */
  sni?: string | null;
  alpn?: string;
  status?: boolean;
  showcerts?: boolean;
  /** Skip STARTTLS on a postgres target: PG17-style direct TLS negotiation. */
  directTls?: boolean;
  sigalgs?: string;
  timeoutS?: number;
}

export type Outcome = "ok" | `refused:alert${number}` | "client-unable" | "timeout" | "no-connect" | "reset" | "starttls-refused" | "not-tls" | "error";

export interface Handshake {
  ok: boolean;
  outcome: Outcome;
  protocol: string;
  cipher: string;
  alpn: string;
  /** TLS 1.3 negotiated group, or the TLS 1.2 ephemeral key. */
  group: string;
  alert: string;
  alertNum: number | null;
  clientSide: boolean;
  verify: string;
  verifyCode: number | null;
  ocsp: "none" | "stapled" | "not-requested";
  subject: string;
  issuer: string;
  pems: string[];
  chainSubjects: string[];
  /** Last meaningful stderr line, for evidence. */
  err: string;
}

/** Pure: openssl s_client stdout + stderr + exit code -> what happened. */
export function parseHandshake(out: string, err: string, exit: number): Handshake {
  const m = (re: RegExp, s = out) => re.exec(s)?.[1]?.trim() ?? "";
  const newLine = /^New, (\S+), Cipher is (\S+)/m.exec(out);
  const ok = !!newLine && newLine[1] !== "(NONE)" && newLine[2] !== "(NONE)";
  const alertNum = /SSL alert number (\d+)/.exec(err);
  const alertText = /alert ([a-z ]+?):/.exec(err);
  const clientSide = /no protocols available|no ciphers available|no cipher match|no suitable signature algorithm/.test(err);
  const verifyMatches = [...out.matchAll(/Verify return code: (\d+) \(([^)]*)\)/g)];
  const lastVerify = verifyMatches[verifyMatches.length - 1];
  const errLines = err.split("\n").map((l) => l.trim()).filter(Boolean);

  let outcome: Outcome;
  if (ok) outcome = "ok";
  else if (exit === 124) outcome = "timeout";
  else if (clientSide) outcome = "client-unable";
  else if (alertNum) outcome = `refused:alert${Number(alertNum[1])}`;
  // The server answered, but not with a TLS record: a plaintext protocol
  // reply to a ClientHello (direct TLS to a port that expects SSLRequest).
  else if (/wrong version number|packet length too long|record layer failure/.test(err)) outcome = "not-tls";
  else if (!/CONNECTED\(/.test(out)) outcome = /STARTTLS|starttls/.test(err) ? "starttls-refused" : "no-connect";
  else if (/errno=104|reset by peer/i.test(err)) outcome = "reset";
  else if (/STARTTLS|starttls|didn't find|did not reply/i.test(err)) outcome = "starttls-refused";
  else outcome = "error";

  let ocsp: Handshake["ocsp"] = "not-requested";
  // TLS 1.3 prints "OCSP responses: no responses sent", TLS 1.2 prints
  // "OCSP response: no OCSP response received" (both seen 2026-10-02).
  if (/OCSP responses?: no (?:OCSP )?responses? (?:sent|received)/.test(out)) ocsp = "none";
  else if (/OCSP Response Status: successful/.test(out)) ocsp = "stapled";

  return {
    ok,
    outcome,
    // NOT the "New, X, Cipher is" label: for a legacy suite OpenSSL prints the
    // suite's minimum version there ("SSLv3" for AES128-SHA negotiated on
    // TLS 1.2). The Protocol line is what was negotiated.
    protocol: ok ? m(/^\s*Protocol\s*:\s*(\S+)/m) || (newLine?.[1] ?? "") : "",
    cipher: ok ? (newLine?.[2] ?? "") : "",
    alpn: m(/^ALPN protocol: (\S+)/m),
    group: m(/^Negotiated TLS1\.3 group: (.+)$/m) || m(/^(?:Peer|Server) Temp Key: (.+)$/m),
    alert: alertText?.[1]?.trim() ?? "",
    alertNum: alertNum ? Number(alertNum[1]) : null,
    clientSide,
    verify: lastVerify?.[2] ?? "",
    verifyCode: lastVerify ? Number(lastVerify[1]) : null,
    ocsp,
    subject: m(/^subject=(.+)$/m),
    issuer: m(/^issuer=(.+)$/m),
    pems: out.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [],
    chainSubjects: [...out.matchAll(/^\s*\d+ s:(.+)$/gm)].map((x) => x[1]?.trim() ?? ""),
    err: errLines.find((l) => /error|alert|errno|refused/i.test(l))?.slice(0, 240) ?? errLines[0]?.slice(0, 240) ?? "",
  };
}

export async function handshake(t: Target, o: HsOpts = {}): Promise<Handshake> {
  const name = o.sni === undefined ? t.host : o.sni;
  const args = ["s_client", "-connect", `${t.connect ?? t.host}:${t.port}`];
  if (name === null) args.push("-noservername");
  else args.push("-servername", name, "-verify_hostname", name);
  if (t.starttls && !o.directTls) args.push("-starttls", t.starttls);
  if (o.proto) args.push(PROTO_FLAG[o.proto]);
  if (o.cipher) args.push("-cipher", o.cipher);
  else if (o.proto === "1.0" || o.proto === "1.1") args.push("-cipher", "DEFAULT:@SECLEVEL=0");
  if (o.suites) args.push("-ciphersuites", o.suites);
  if (o.alpn) args.push("-alpn", o.alpn);
  if (o.status) args.push("-status");
  if (o.showcerts) args.push("-showcerts");
  if (o.sigalgs) args.push("-sigalgs", o.sigalgs);
  const r = await $`timeout ${String(o.timeoutS ?? 10)} openssl ${args} < /dev/null`.quiet().nothrow();
  return parseHandshake(r.stdout.toString(), r.stderr.toString(), r.exitCode);
}

/** Every TLS <= 1.2 suite this OpenSSL build can offer, at security level 0. */
export async function offerableTls12(): Promise<string[]> {
  const r = await $`openssl ciphers -tls1_2 ${"ALL:COMPLEMENTOFALL:@SECLEVEL=0"}`.quiet().nothrow();
  return r.stdout.toString().trim().split(":").filter((c) => c && !c.startsWith("TLS_"));
}

export interface Enumeration {
  offered: number;
  accepted: string[];
  cbcAccepted: string[];
  /** Per ECDHE_CBC_SHA2 suite: "accepted" | the outcome. Diffable across runs. */
  ecdheCbc: Record<string, string>;
  tls13: Record<string, string>;
  /** Any outcome that was neither ok nor a server refusal - flags a noisy run. */
  anomalies: string[];
}

/** One handshake per suite. A suite is accepted only if the server picked exactly it. */
export async function enumerate(t: Target, concurrency = 6): Promise<Enumeration> {
  const suites = await offerableTls12();
  const rows = await pool(suites, concurrency, async (c) => ({ c, h: await handshake(t, { proto: "1.2", cipher: `${c}:@SECLEVEL=0` }) }));
  const accepted = rows.filter((r) => r.h.ok && r.h.cipher === r.c).map((r) => r.c);
  const anomalies = rows.filter((r) => !r.h.ok && !r.h.outcome.startsWith("refused") && r.h.outcome !== "client-unable").map((r) => `${r.c}:${r.h.outcome}`);
  const ecdheCbc: Record<string, string> = {};
  for (const c of ECDHE_CBC_SHA2) {
    const row = rows.find((r) => r.c === c);
    ecdheCbc[c] = !row ? "not-offerable-by-client" : row.h.ok && row.h.cipher === c ? "accepted" : row.h.outcome;
  }
  const tls13: Record<string, string> = {};
  for (const s of TLS13_SUITES) {
    const h = await handshake(t, { proto: "1.3", suites: s });
    tls13[s] = h.ok && h.cipher === s ? "accepted" : h.outcome;
  }
  return { offered: suites.length, accepted, cbcAccepted: accepted.filter(isCbc), ecdheCbc, tls13, anomalies };
}

export interface Protocols {
  /** Per protocol: "ok" or the outcome. */
  result: Record<Proto, string>;
  /** Cipher the server chose at each accepted protocol with the client's default list. */
  chosen: Record<Proto, string>;
}

export async function protocols(t: Target): Promise<Protocols> {
  const result = {} as Record<Proto, string>;
  const chosen = {} as Record<Proto, string>;
  for (const p of PROTOS) {
    const h = await handshake(t, { proto: p });
    result[p] = h.outcome;
    chosen[p] = h.cipher;
  }
  return { result, chosen };
}

/* ---------- certificates ---------- */

export interface CertInfo {
  subject: string;
  issuer: string;
  keyType: string;
  keyBits: number;
  sigAlg: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  daysLeft: number;
  lifetimeDays: number;
  sha256: string;
}

/** Pure: `openssl x509 -noout -text` -> the fields a cert review asks for. */
export function parseCertText(text: string, now = new Date()): Omit<CertInfo, "subject" | "issuer" | "sha256"> {
  const g = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? "";
  const alg = g(/Public Key Algorithm: (\S+)/);
  const keyType = alg === "id-ecPublicKey" ? "EC" : alg === "rsaEncryption" ? "RSA" : alg;
  const nb = new Date(g(/Not Before\s*: (.+)/));
  const na = new Date(g(/Not After\s*: (.+)/));
  const sanLine = /X509v3 Subject Alternative Name:\s*(?:critical)?\s*\n\s*(.+)/.exec(text)?.[1] ?? "";
  const iso = (d: Date) => (Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10));
  return {
    keyType,
    keyBits: Number(g(/Public-Key: \((\d+) bit\)/)) || 0,
    sigAlg: g(/Signature Algorithm: (\S+)/),
    sans: sanLine.split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean),
    notBefore: iso(nb),
    notAfter: iso(na),
    daysLeft: Math.floor((na.getTime() - now.getTime()) / 86_400_000),
    lifetimeDays: Math.round((na.getTime() - nb.getTime()) / 86_400_000),
  };
}

export async function certInfo(pem: string): Promise<CertInfo> {
  const dir = await mkdtemp(join(tmpdir(), "tls-surface-"));
  try {
    const f = join(dir, "c.pem");
    await writeFile(f, pem);
    const text = (await $`openssl x509 -noout -text -in ${f}`.quiet().nothrow()).stdout.toString();
    const names = (await $`openssl x509 -noout -subject -issuer -fingerprint -sha256 -nameopt RFC2253 -in ${f}`.quiet().nothrow()).stdout.toString();
    return {
      subject: /^subject=(.+)$/m.exec(names)?.[1] ?? "",
      issuer: /^issuer=(.+)$/m.exec(names)?.[1] ?? "",
      sha256: /Fingerprint=(.+)$/m.exec(names)?.[1]?.replace(/:/g, "").toLowerCase().slice(0, 16) ?? "",
      ...parseCertText(text),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a PEM set to a temp file for a client that wants a path; caller removes the dir. */
export async function pemFile(pems: string[]): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tls-surface-"));
  const path = join(dir, "ca.pem");
  await writeFile(path, `${pems.join("\n")}\n`);
  return { path, dir };
}

/* ---------- targets ---------- */

/** The address 1.1.1.1 returns, for names the vantage's own resolver overrides (lab zone split-horizon). */
export async function publicA(host: string): Promise<string> {
  const out = (await $`dig +short @1.1.1.1 ${host} A`.quiet().nothrow()).stdout.toString().trim().split("\n");
  return out.filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l)).pop() ?? "";
}

/**
 * Every HTTPS name a project answers on. `functions` is the legacy
 * `<ref>.functions.supabase.co` form; whether it still resolves is itself a
 * row. `mgmt` is the control plane, on a different name and zone - a control
 * for the project edge config.
 */
export async function edgeTargets(ctx: Ctx): Promise<Target[]> {
  const t: Target[] = [
    { role: "api", host: ctx.apiHost, port: 443 },
    { role: "storage", host: `${ctx.ref}.storage.supabase.co`, port: 443 },
    { role: "functions", host: `${ctx.ref}.functions.supabase.co`, port: 443 },
    { role: "mgmt", host: "api.supabase.com", port: 443 },
  ];
  const cd = ctx.endpoints.custom_domain;
  if (cd) t.push({ role: "custom_domain", host: cd, port: 443, connect: (await publicA(cd)) || undefined });
  return t;
}

/* ---------- curl ---------- */

export interface CurlOpts {
  url: string;
  /** host -> address pin, as curl --resolve (port 443 unless given). */
  pin?: { host: string; ip: string; port?: number };
  ciphers?: string;
  tlsMax?: "1.2" | "1.3";
  tlsMin?: "1.0" | "1.1" | "1.2" | "1.3";
  http?: "1.1" | "2" | "3only";
  headers?: string[];
  maxTimeS?: number;
}

export interface CurlResult {
  code: number;
  httpVersion: string;
  /** Negotiated "TLSv1.2 / ECDHE-RSA-AES128-SHA256", from curl's verbose trace. */
  tls: string;
  headers: Record<string, string>;
  err: string;
  exit: number;
}

export async function curl(o: CurlOpts): Promise<CurlResult> {
  const args = ["-s", "-v", "-o", "/dev/null", "-D", "-", "--max-time", String(o.maxTimeS ?? 15), "-w", "\n__W__%{http_code} %{http_version}"];
  if (o.pin) args.push("--resolve", `${o.pin.host}:${o.pin.port ?? 443}:${o.pin.ip}`);
  if (o.ciphers) args.push("--ciphers", o.ciphers);
  if (o.tlsMax) args.push("--tls-max", o.tlsMax);
  if (o.tlsMin) args.push(`--tlsv${o.tlsMin}`);
  if (o.http === "1.1") args.push("--http1.1");
  if (o.http === "2") args.push("--http2");
  if (o.http === "3only") args.push("--http3-only");
  for (const h of o.headers ?? []) args.push("-H", h);
  args.push(o.url);
  const r = await $`curl ${args}`.quiet().nothrow();
  const out = r.stdout.toString();
  const w = /__W__(\d+) (\S+)/.exec(out);
  const headers: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const hm = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (hm?.[1]) headers[hm[1].toLowerCase()] = hm[2] ?? "";
  }
  const trace = r.stderr.toString();
  const tls = /SSL connection using (\S+) \/ (\S+)/.exec(trace);
  const errLine = trace.split("\n").filter((l) => /^curl: |^\* (TLS connect error|OpenSSL|SSL|Failed|Could not)/.test(l)).pop() ?? "";
  return { code: Number(w?.[1] ?? 0), httpVersion: w?.[2] ?? "", tls: tls ? `${tls[1]} / ${tls[2]}` : "", headers, err: errLine.replace(/^\* /, "").slice(0, 200), exit: r.exitCode };
}

/* ---------- misc ---------- */

/** Ordered map with bounded concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
