/**
 * Network probes for the hostname-path experiment: dig through a chosen
 * resolver, DNS-over-HTTPS JSON, and one curl with the per-phase timers.
 * Pure parsers are exported so `net.test.ts` can pin them without a network.
 */

export interface DnsAnswer {
  name: string;
  ttl: number;
  type: string;
  data: string;
}

export interface DigResult {
  /** NOERROR | NXDOMAIN | SERVFAIL | ... or "NO-REPLY" when dig printed no header. */
  rcode: string;
  flags: string[];
  answers: DnsAnswer[];
  queryMs: number | null;
  raw: string;
}

/** Parse `dig +noall +answer +comments +stats` output. */
export function parseDig(out: string): DigResult {
  const rcode = /status:\s*([A-Z]+)/.exec(out)?.[1] ?? "NO-REPLY";
  const flags = (/flags:\s*([a-z ]+);/.exec(out)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const q = /Query time:\s*(\d+)\s*msec/.exec(out)?.[1];
  const answers: DnsAnswer[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\S+)\s+(\d+)\s+IN\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (m && !line.startsWith(";")) answers.push({ name: m[1]!, ttl: Number(m[2]), type: m[3]!, data: m[4]!.trim() });
  }
  return { rcode, flags, answers, queryMs: q ? Number(q) : null, raw: out };
}

export async function run(cmd: string[], timeoutMs = 30_000): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { out, err, code };
}

/** First of `tools` not found on PATH, or null when all are present. */
export function missingTool(...tools: string[]): string | null {
  return tools.find((t) => !Bun.which(t)) ?? null;
}

/** True when a Docker daemon answers (`docker info` exits 0). */
export async function dockerUp(): Promise<boolean> {
  if (!Bun.which("docker")) return false;
  try {
    return (await run(["docker", "info"], 20_000)).code === 0;
  } catch {
    return false;
  }
}

/** dig through `server` (undefined = the system resolver config). */
export async function dig(server: string | undefined, name: string, type: string, extra: string[] = [], port?: number): Promise<DigResult> {
  const args = ["dig", "+time=5", "+tries=1", "+noall", "+answer", "+comments", "+stats", ...extra];
  if (server) args.push(`@${server}`);
  if (port) args.push("-p", String(port));
  args.push(name, type);
  const r = await run(args, 20_000);
  return parseDig(r.out);
}

export interface DohResult {
  status: number;
  rcode: number | null;
  ad: boolean | null;
  answers: DnsAnswer[];
  error?: string;
}

const RTYPES: Record<number, string> = { 1: "A", 5: "CNAME", 28: "AAAA", 2: "NS", 16: "TXT" };

/** Parse a DoH JSON answer (both Cloudflare and Google use the same shape). */
export function parseDoh(status: number, body: string): DohResult {
  try {
    const j = JSON.parse(body) as { Status?: number; AD?: boolean; Answer?: { name: string; type: number; TTL: number; data: string }[] };
    return {
      status,
      rcode: j.Status ?? null,
      ad: j.AD ?? null,
      answers: (j.Answer ?? []).map((a) => ({ name: a.name, ttl: a.TTL, type: RTYPES[a.type] ?? String(a.type), data: a.data })),
    };
  } catch {
    return { status, rcode: null, ad: null, answers: [], error: body.slice(0, 120) };
  }
}

export async function doh(endpoint: "cloudflare" | "google", name: string, type: string): Promise<DohResult> {
  const base = endpoint === "cloudflare" ? "https://cloudflare-dns.com/dns-query" : "https://dns.google/resolve";
  try {
    const r = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(15_000),
    });
    return parseDoh(r.status, await r.text());
  } catch (e) {
    return { status: 0, rcode: null, ad: null, answers: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
  }
}

export interface Phases {
  code: number;
  dnsMs: number;
  tcpMs: number;
  tlsMs: number;
  ttfbMs: number;
  totalMs: number;
  ip: string;
  colo: string;
  err: string;
}

/** Turn curl's cumulative timers (seconds) into per-phase milliseconds. */
export function phasesFrom(w: string): Phases {
  const [code, dns, conn, app, ttfb, total, ip, ray] = w.trim().split("\t");
  const n = (s: string | undefined) => Number(s ?? "0") * 1000;
  const colo = (ray ?? "").split("-").pop() ?? "";
  return {
    code: Number(code) || 0,
    dnsMs: n(dns),
    tcpMs: n(conn) - n(dns),
    tlsMs: n(app) - n(conn),
    ttfbMs: n(ttfb) - n(app),
    totalMs: n(total),
    ip: ip ?? "",
    colo,
    err: "",
  };
}

const FMT = "%{http_code}\t%{time_namelookup}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{remote_ip}\t%header{cf-ray}";

/** One fresh-connection GET with phase timers. */
export async function curlPhases(url: string, headers: Record<string, string> = {}, resolve?: string): Promise<Phases> {
  const args = ["curl", "-s", "-o", "/dev/null", "--max-time", "20", "-w", FMT];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (resolve) args.push("--resolve", resolve);
  args.push(url);
  const r = await run(args, 30_000);
  const p = phasesFrom(r.out);
  if (!p.code) p.err = r.err.trim().slice(-120) || `curl exit ${r.code}`;
  return p;
}

export function pct(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
