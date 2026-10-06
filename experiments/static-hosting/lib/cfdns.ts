/**
 * Cloudflare DNS for the custom-hostname modules: the records the platform
 * asks for, written into a Cloudflare-hosted zone through the v4 API, so the
 * run needs no manual DNS and no knotctl (medium-serverless MS13 used Knot).
 *
 * Credentials come from the environment (`CLOUDFLARE_API_KEY` +
 * `CLOUDFLARE_EMAIL`, injected per command by `sx`); the zone is the last two
 * labels of the hostname. Records are DNS-only (proxied=false): the custom
 * hostname is served by Cloudflare for SaaS on Supabase's account, and an
 * orange-clouded CNAME from a second account would sit in front of it.
 */
import { $ } from "bun";

const API = "https://api.cloudflare.com/client/v4";

function headers(): Record<string, string> {
  const key = process.env.CLOUDFLARE_API_KEY ?? "";
  const email = process.env.CLOUDFLARE_EMAIL ?? "";
  if (!key || !email) throw new Error("CLOUDFLARE_API_KEY / CLOUDFLARE_EMAIL not in the environment");
  return { "X-Auth-Key": key, "X-Auth-Email": email, "Content-Type": "application/json" };
}

export const cfAvailable = () => !!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_EMAIL;

export async function zoneId(host: string): Promise<string> {
  const zone = host.split(".").slice(-2).join(".");
  const r = await fetch(`${API}/zones?name=${zone}`, { headers: headers() });
  const j = (await r.json()) as { result?: { id: string }[] };
  const id = j.result?.[0]?.id;
  if (!id) throw new Error(`zone ${zone} not visible to these Cloudflare credentials (HTTP ${r.status})`);
  return id;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

export async function listRecords(zone: string, name: string): Promise<DnsRecord[]> {
  const r = await fetch(`${API}/zones/${zone}/dns_records?name=${encodeURIComponent(name)}&per_page=100`, { headers: headers() });
  const j = (await r.json()) as { result?: DnsRecord[] };
  return j.result ?? [];
}

/** Create, or replace a same-name same-type record so a re-run converges. */
export async function upsertRecord(zone: string, type: "CNAME" | "TXT", name: string, content: string): Promise<{ status: number; error: string }> {
  for (const old of (await listRecords(zone, name)).filter((x) => x.type === type)) {
    if (type === "CNAME" || old.content.replace(/"/g, "") === content) {
      if (old.content.replace(/"/g, "") === content) return { status: 200, error: "" };
      await fetch(`${API}/zones/${zone}/dns_records/${old.id}`, { method: "DELETE", headers: headers() });
    }
  }
  const r = await fetch(`${API}/zones/${zone}/dns_records`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type, name, content, ttl: 60, proxied: false, comment: "pvlab static-hosting (throwaway)" }),
  });
  const j = (await r.json()) as { success?: boolean; errors?: { message: string }[] };
  return { status: r.status, error: j.success ? "" : (j.errors ?? []).map((e) => e.message).join("; ") };
}

/** Remove every record at a name (the custom host and its validation TXT names). */
export async function removeRecords(zone: string, names: string[]): Promise<number> {
  let n = 0;
  for (const name of names) {
    for (const rec of await listRecords(zone, name)) {
      const r = await fetch(`${API}/zones/${zone}/dns_records/${rec.id}`, { method: "DELETE", headers: headers() });
      if (r.ok) n++;
    }
  }
  return n;
}

/**
 * The address 1.1.1.1 returns for a name. Probes and the browser are pinned to
 * it: a fresh name is not in every resolver yet, and medium-serverless MS13
 * lost two runs to a LAN resolver answering a private address for the zone.
 */
export async function publicIp(host: string): Promise<string> {
  const lines = (await $`dig +short @1.1.1.1 ${host} A`.quiet().nothrow()).stdout
    .toString()
    .trim()
    .split("\n")
    .filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
  return lines[lines.length - 1] ?? "";
}

/** One GET through curl pinned to `ip`; TLS still validates against the hostname. */
export async function pinnedGet(host: string, ip: string, path: string): Promise<{ status: number; contentType: string; err: string }> {
  const r = await $`curl -s -o /dev/null -w ${"%{http_code} %{content_type}"} --max-time 15 --resolve ${`${host}:443:${ip}`} ${`https://${host}${path}`}`
    .quiet()
    .nothrow();
  const [code, ...ct] = r.stdout.toString().trim().split(" ");
  const status = Number(code) || 0;
  return { status, contentType: ct.join(" "), err: status ? "" : r.stderr.toString().trim().slice(-120) || `curl exit ${r.exitCode}` };
}
