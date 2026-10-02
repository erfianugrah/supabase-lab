/**
 * TL10 - the TLS surface of every Postgres path: shared pooler (Supavisor)
 * session 5432 and transaction 6543, and - when reachable from this vantage
 * (TL14 turns the IPv4 add-on on) - direct 5432 and the dedicated PgBouncer
 * on 6543.
 *
 * Postgres TLS starts in-band (SSLRequest), so every handshake here is
 * `openssl s_client -starttls postgres`. Per path: protocol versions, the
 * full TLS 1.2 suite enumeration (what a scanner pointed at the database
 * host would list), the presented
 * chain (leaf SANs, issuer, root, validity), whether the system trust store
 * verifies it, and PG17-style direct TLS (ClientHello straight away, ALPN
 * `postgresql`, the libpq `sslnegotiation=direct` path).
 *
 * `root_fp` is the fingerprint of the self-signed root at the end of the
 * chain; equal across paths means one CA to distribute. Read-only.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { pgPaths, tlsTarget } from "../lib/pg";
import { certInfo, enumerate, handshake, protocols, PROTOS } from "../lib/tls";

const mod: TestModule = {
  id: "TL10",
  title: "Postgres paths: protocols, cipher suites, certificate chain, direct TLS",
  where: "local",
  requires: ["openssl"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL10", title: mod.title, status: "skip", detail: "no project ref" }];
    const out: TestResult[] = [];
    for (const p of await pgPaths(ctx)) {
      const id = `TL10-${p.name}`;
      if (!p.reachable) {
        out.push({ id, title: `${p.name}: TLS surface`, status: "skip", detail: p.why });
        continue;
      }
      const t = tlsTarget(p);
      const proto = await protocols(t);
      const e = await enumerate(t);
      const chain = await handshake(t, { showcerts: true });
      const certs = await Promise.all(chain.pems.map((pem) => certInfo(pem)));
      const leaf = certs[0];
      const root = certs[certs.length - 1];
      const direct = await handshake(t, { directTls: true, alpn: "postgresql" });
      const m: Record<string, string | number> = {
        ...Object.fromEntries(PROTOS.map((v) => [`tls${v.replace(".", "")}`, proto.result[v]])),
        tls12_accepted: e.accepted.length,
        tls12_cbc_accepted: e.cbcAccepted.length,
        cbc_suites: e.cbcAccepted.join(":") || "none",
        ...Object.fromEntries(Object.entries(e.tls13).map(([k, v]) => [k, v])),
        chain_len: certs.length,
        leaf_subject: leaf?.subject.replace(/,.*$/, "") ?? "-",
        leaf_sans: leaf?.sans.join(" ") ?? "-",
        leaf_key: leaf ? `${leaf.keyType}-${leaf.keyBits}` : "-",
        leaf_not_after: leaf?.notAfter ?? "-",
        leaf_lifetime_days: leaf?.lifetimeDays ?? 0,
        issuer: leaf?.issuer.replace(/,.*$/, "") ?? "-",
        root: root?.subject.replace(/,.*$/, "") ?? "-",
        root_not_after: root?.notAfter ?? "-",
        root_fp: root?.sha256 ?? "-",
        system_store_verify: chain.verifyCode === 0 ? "ok" : `${chain.verifyCode} ${chain.verify}`,
        group: chain.group,
        direct_tls: direct.ok ? `ok ${direct.protocol} alpn=${direct.alpn || "none"}` : direct.outcome,
      };
      out.push({
        id,
        title: `${p.name} (${p.host}:${p.port}): TLS surface`,
        status: "info",
        detail: `protocols ${PROTOS.map((v) => `${v}:${proto.result[v]}`).join(" ")}; ${e.accepted.length} TLS 1.2 suites, ${e.cbcAccepted.length} CBC; chain ${certs.map((c) => c.subject.replace(/,.*$/, "")).join(" <- ")}; leaf SANs [${leaf?.sans.join(" ") ?? ""}], ${leaf?.lifetimeDays ?? "?"}d lifetime; system store ${m.system_store_verify}; direct TLS ${m.direct_tls}`,
        measurements: m,
      });
    }
    return out;
  },
};
export default mod;
