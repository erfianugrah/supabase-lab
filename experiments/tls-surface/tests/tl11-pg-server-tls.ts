/**
 * TL11 - what Postgres itself is configured with, and what each hop
 * negotiates.
 *
 * Through every reachable path, one node-postgres session reads:
 *   - the server's TLS settings (`ssl`, `ssl_min_protocol_version`,
 *     `ssl_ciphers`, `ssl_ecdh_curve`, `ssl_prefer_server_ciphers`);
 *   - `pg_stat_ssl` for its OWN backend. Direct, that row is the client's
 *     TLS. Through a pooler it is the POOLER -> Postgres hop, which the
 *     client never sees: `hop_ssl=false` there means the hop inside the
 *     platform is plaintext Postgres protocol, whatever the client used;
 *   - the client socket's own protocol and cipher (Bun/Node defaults);
 *   - `pg_hba_file_rules`, if the role may read it (hostssl vs host lines
 *     decide whether plaintext is accepted at all).
 *
 * TL16 re-reads the pooler hop with SSL enforcement on. Read-only.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { nodeSession, pgPaths } from "../lib/pg";

const SQL = `select current_setting('ssl') as ssl,
  current_setting('ssl_min_protocol_version') as min_proto,
  current_setting('ssl_max_protocol_version', true) as max_proto,
  current_setting('ssl_ciphers') as ciphers,
  current_setting('ssl_ecdh_curve', true) as ecdh_curve,
  current_setting('ssl_prefer_server_ciphers') as prefer_server,
  s.ssl as backend_ssl, s.version as backend_version, s.cipher as backend_cipher,
  inet_client_addr()::text as client_addr,
  (select count(*) from pg_stat_ssl where ssl) as ssl_backends_visible,
  (select count(*) from pg_stat_ssl) as backends_visible
from pg_stat_ssl s where s.pid = pg_backend_pid()`;

const HBA = "select type || ' ' || array_to_string(database, ',') || ' ' || array_to_string(user_name, ',') || ' ' || coalesce(address, '') || ' ' || coalesce(auth_method, '') as rule from pg_hba_file_rules order by rule_number";

const mod: TestModule = {
  id: "TL11",
  title: "Postgres: server TLS settings, per-hop pg_stat_ssl, client-side negotiation, hba rules",
  where: "local",
  requires: ["db"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL11", title: mod.title, status: "skip", detail: "no project ref" }];
    const out: TestResult[] = [];
    let hbaDone = false;
    for (const p of await pgPaths(ctx)) {
      const id = `TL11-${p.name}`;
      if (!p.reachable) {
        out.push({ id, title: `${p.name}: server TLS`, status: "skip", detail: p.why });
        continue;
      }
      const s = await nodeSession(p, ctx.dbPassword, SQL);
      const row = (s.rows[0] ?? {}) as Record<string, string | boolean | number | null>;
      if (!s.ok) {
        out.push({ id, title: `${p.name}: server TLS`, status: "fail", detail: s.err });
        continue;
      }
      const hop = p.name.startsWith("direct") ? "client->postgres" : "pooler->postgres";
      out.push({
        id,
        title: `${p.name}: server TLS settings and the ${hop} hop`,
        status: "info",
        detail: `ssl=${row.ssl}, min ${row.min_proto}, max ${row.max_proto || "unset"}, ciphers '${row.ciphers}', curve ${row.ecdh_curve ?? "?"}; ${hop} hop: ssl=${row.backend_ssl} ${row.backend_version ?? ""} ${row.backend_cipher ?? ""}; client socket ${s.clientProtocol} ${s.clientCipher}; backend sees client ${row.client_addr ?? "?"}; ${row.ssl_backends_visible}/${row.backends_visible} visible backends on TLS`,
        measurements: {
          server_ssl: String(row.ssl),
          min_proto: String(row.min_proto),
          max_proto: String(row.max_proto || "unset"),
          ssl_ciphers: String(row.ciphers),
          ecdh_curve: String(row.ecdh_curve ?? "?"),
          [`hop_ssl`]: String(row.backend_ssl),
          hop_version: String(row.backend_version ?? "-"),
          hop_cipher: String(row.backend_cipher ?? "-"),
          client_protocol: s.clientProtocol,
          client_cipher: s.clientCipher,
          ssl_backends_visible: Number(row.ssl_backends_visible ?? 0),
          backends_visible: Number(row.backends_visible ?? 0),
        },
      });
      if (!hbaDone) {
        hbaDone = true;
        const h = await nodeSession(p, ctx.dbPassword, HBA);
        out.push({
          id: "TL11-hba",
          title: "pg_hba_file_rules as the postgres role",
          status: "info",
          detail: h.ok ? `${h.rows.length} rules: ${h.rows.map((r) => String(r.rule).trim()).join(" | ").slice(0, 900)}` : `not readable: ${h.err}`,
          measurements: { readable: h.ok ? "yes" : "no", rules: h.rows.length, hostssl_rules: h.rows.filter((r) => String(r.rule).startsWith("hostssl")).length, host_rules: h.rows.filter((r) => String(r.rule).startsWith("host ")).length },
        });
      }
    }
    return out;
  },
};
export default mod;
