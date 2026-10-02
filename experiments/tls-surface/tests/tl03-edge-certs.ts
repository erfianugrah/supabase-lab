/**
 * TL03 - the certificates each HTTPS name presents.
 *
 * An edge can hold an ECDSA and an RSA certificate for the same name and pick
 * by what the client offers, so both are requested explicitly (TLS 1.2 with
 * `aECDSA` / `aRSA` only) and the TLS 1.3 default is recorded separately.
 * Per certificate: issuer, key, signature algorithm, SANs, validity and days
 * left, whether the system trust store verifies it with hostname checking,
 * and whether an OCSP response is stapled. A short lifetime (~90 days) means
 * automated rotation: pinning a leaf is wrong for these names, which is the
 * row to point a customer at who asks for "the certificate".
 *
 * `same_leaf_as_api` compares fingerprints: names served by one terminator
 * with one certificate share a leaf. Read-only.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { certInfo, edgeTargets, handshake, type Target } from "../lib/tls";

export async function certRows(prefix: string, targets: Target[]): Promise<TestResult[]> {
  const out: TestResult[] = [];
  let apiFp: Record<string, string> = {};
  for (const t of targets) {
    const m: Record<string, string | number> = {};
    const notes: string[] = [];
    let any = false;
    for (const [kind, opts] of [
      ["ecdsa", { proto: "1.2" as const, cipher: "aECDSA" }],
      ["rsa", { proto: "1.2" as const, cipher: "aRSA" }],
      ["tls13", { proto: "1.3" as const }],
    ] as const) {
      const h = await handshake(t, { ...opts, status: true, showcerts: true });
      if (!h.ok || !h.pems[0]) {
        m[`${kind}`] = h.outcome;
        notes.push(`${kind}: ${h.outcome}`);
        continue;
      }
      any = true;
      const c = await certInfo(h.pems[0]);
      const covered = c.sans.some((s) => s === t.host || (s.startsWith("*.") && t.host.endsWith(s.slice(1)) && t.host.split(".").length === s.split(".").length));
      Object.assign(m, {
        [`${kind}_issuer`]: c.issuer.replace(/,.*$/, ""),
        [`${kind}_key`]: `${c.keyType}-${c.keyBits}`,
        [`${kind}_sigalg`]: c.sigAlg,
        [`${kind}_not_after`]: c.notAfter,
        [`${kind}_days_left`]: c.daysLeft,
        [`${kind}_lifetime_days`]: c.lifetimeDays,
        [`${kind}_sans`]: c.sans.length,
        [`${kind}_name_in_san`]: covered ? "yes" : "no",
        [`${kind}_verify`]: h.verifyCode === 0 ? "ok" : `${h.verifyCode} ${h.verify}`,
        [`${kind}_ocsp`]: h.ocsp,
        [`${kind}_chain`]: h.pems.length,
        [`${kind}_fp`]: c.sha256,
      });
      if (kind === "tls13") m.tls13_group = h.group;
      notes.push(`${kind}: ${c.keyType}-${c.keyBits} from ${c.issuer.replace(/,.*$/, "")}, ${c.lifetimeDays}d lifetime, ${c.daysLeft}d left, verify ${h.verifyCode === 0 ? "ok" : h.verify}, OCSP ${h.ocsp}, SANs [${c.sans.slice(0, 4).join(" ")}${c.sans.length > 4 ? " ..." : ""}]`);
    }
    if (t.role === "api") apiFp = { ecdsa: String(m.ecdsa_fp ?? ""), rsa: String(m.rsa_fp ?? "") };
    else if (any && apiFp.ecdsa) m.same_leaf_as_api = m.ecdsa_fp === apiFp.ecdsa || m.rsa_fp === apiFp.rsa ? "yes" : "no";
    const verified = ["ecdsa", "rsa", "tls13"].filter((k) => m[`${k}_verify`] !== undefined).every((k) => m[`${k}_verify`] === "ok" && m[`${k}_name_in_san`] === "yes");
    out.push({
      id: `${prefix}-${t.role}`,
      title: `${t.host}: certificates (ECDSA, RSA, TLS 1.3 default)`,
      status: !any ? "info" : verified ? "pass" : "fail",
      detail: any ? notes.join("; ") : `no certificate - ${notes.join(", ")}`,
      measurements: m,
    });
  }
  return out;
}

const mod: TestModule = {
  id: "TL03",
  title: "HTTP edge: certificates per project hostname",
  where: "local",
  requires: ["openssl"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL03", title: mod.title, status: "skip", detail: "no project ref" }];
    return certRows("TL03", await edgeTargets(ctx));
  },
};
export default mod;
