/**
 * Cloudflare DNS for the custom hostname: records written into a
 * Cloudflare-hosted zone through the v4 API with the account's global key
 * (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`, injected by `sx`). The scoped
 * `CLOUDFLARE_TOKEN` did not list the target zone on 2026-10-10 (zones list
 * returned an empty result, DNS records `Authentication error`), so the key
 * pair is used, as in static-hosting.
 *
 * Records are DNS-only (proxied=false): the custom hostname is served by
 * Cloudflare for SaaS on the platform's account.
 */
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

export type RType = "A" | "AAAA" | "CNAME" | "TXT";

/** Create a record; an identical one is left alone. */
export async function addRecord(zone: string, type: RType, name: string, content: string): Promise<{ status: number; error: string }> {
  for (const old of await listRecords(zone, name)) {
    if (old.type === type && old.content.replace(/"/g, "") === content) return { status: 200, error: "" };
  }
  const r = await fetch(`${API}/zones/${zone}/dns_records`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type, name, content, ttl: 60, proxied: false, comment: "pvlab hostname-path (throwaway)" }),
  });
  const j = (await r.json()) as { success?: boolean; errors?: { message: string }[] };
  return { status: r.status, error: j.success ? "" : (j.errors ?? []).map((e) => e.message).join("; ") };
}

/** Remove every record of the given types at a name (all types when omitted). */
export async function removeRecords(zone: string, names: string[], types?: RType[]): Promise<number> {
  let n = 0;
  for (const name of names) {
    for (const rec of await listRecords(zone, name)) {
      if (types && !types.includes(rec.type as RType)) continue;
      const r = await fetch(`${API}/zones/${zone}/dns_records/${rec.id}`, { method: "DELETE", headers: headers() });
      if (r.ok) n++;
    }
  }
  return n;
}
