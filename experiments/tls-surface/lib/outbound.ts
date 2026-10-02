/**
 * Outbound TLS targets for TL20 (pg_net, i.e. the database host's libcurl)
 * and TL21 (an Edge Function's fetch, i.e. the Deno runtime).
 *
 * Each target is a public test host built to fail one specific check. The
 * question per target is "does this client refuse what a verifying, modern
 * client refuses?". The vantage (curl on the orchestrator) runs the same
 * list as the control, so a target that has changed upstream shows up as a
 * control that no longer matches its expectation.
 *
 * howsmyssl echoes the client's own handshake back (version, offered
 * suites), which is the one way to see what a server-side client offers.
 */
export interface OutboundTarget {
  id: string;
  url: string;
  /** What a verifying modern client does. */
  expect: "connect" | "refuse";
}

export const OUTBOUND: OutboundTarget[] = [
  { id: "howsmyssl", url: "https://www.howsmyssl.com/a/check", expect: "connect" },
  { id: "tls12_only", url: "https://tls-v1-2.badssl.com:1012/", expect: "connect" },
  { id: "tls11_only", url: "https://tls-v1-1.badssl.com:1011/", expect: "refuse" },
  { id: "tls10_only", url: "https://tls-v1-0.badssl.com:1010/", expect: "refuse" },
  { id: "cbc_only", url: "https://cbc.badssl.com/", expect: "connect" },
  { id: "rc4", url: "https://rc4.badssl.com/", expect: "refuse" },
  { id: "3des", url: "https://3des.badssl.com/", expect: "refuse" },
  { id: "expired", url: "https://expired.badssl.com/", expect: "refuse" },
  { id: "self_signed", url: "https://self-signed.badssl.com/", expect: "refuse" },
  { id: "untrusted_root", url: "https://untrusted-root.badssl.com/", expect: "refuse" },
  { id: "wrong_host", url: "https://wrong.host.badssl.com/", expect: "refuse" },
  { id: "revoked", url: "https://revoked.badssl.com/", expect: "refuse" },
];

export interface HowsMySsl {
  tls_version?: string;
  rating?: string;
  given_cipher_suites?: string[];
  insecure_cipher_suites?: Record<string, string[]>;
}

/** Pure: the fields worth a column from a howsmyssl echo. */
export function summariseHowsMySsl(body: string): Record<string, string | number> {
  try {
    const j = JSON.parse(body) as HowsMySsl;
    const suites = j.given_cipher_suites ?? [];
    return {
      client_tls: j.tls_version ?? "?",
      client_rating: j.rating ?? "?",
      client_suites_offered: suites.length,
      client_cbc_offered: suites.filter((s) => /_CBC_/.test(s)).length,
      client_insecure: Object.keys(j.insecure_cipher_suites ?? {}).length,
    };
  } catch {
    return { client_tls: "unparsed" };
  }
}

/** connect/refuse from a status (0 = no response) and an error text. */
export const verdict = (status: number): "connect" | "refuse" => (status > 0 ? "connect" : "refuse");
