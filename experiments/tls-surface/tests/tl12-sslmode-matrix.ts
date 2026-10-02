/**
 * TL12 - the libpq sslmode matrix on every reachable Postgres path.
 *
 * psql 18, one connection per cell, each running a `pg_stat_ssl` read for
 * its own backend so a successful connection also says what TLS (if any)
 * the hop into Postgres used. Cells:
 *
 *   disable / allow / prefer / require   - is plaintext accepted at all,
 *                                          and what does each mode end up on
 *   verify-ca, verify-full + system      - `sslrootcert=system`: do the
 *                                          platform certs chain to a public
 *                                          root (they should not: TL10)
 *   verify-ca, verify-full + chain root  - the self-signed root taken from
 *                                          the server's own chain (trust on
 *                                          first use; production takes the
 *                                          CA from the dashboard). This is
 *                                          the cell the docs prescribe
 *   verify-full, wrong name              - negative control: hostaddr pinned
 *                                          to the real address, host set to
 *                                          a name not in the cert, must fail
 *   require + sslnegotiation=direct      - PG17 direct TLS (no SSLRequest)
 *
 * With SSL enforcement off (the default) `disable` succeeding is expected;
 * TL16 turns enforcement on and re-runs the plaintext cells. Read-only.
 */
import { $ } from "bun";
import { rm } from "node:fs/promises";
import type { TestModule, TestResult } from "../../../harness/src/types";
import { type PgPath, pgPaths, psql, SELF_SSL_SQL, tlsTarget } from "../lib/pg";
import { handshake, pemFile } from "../lib/tls";

export interface Cell {
  name: string;
  params: Record<string, string>;
  /** Expected to fail by design (negative control). */
  negative?: boolean;
}

export function cells(rootPath: string, ip: string): Cell[] {
  return [
    { name: "disable", params: { sslmode: "disable" } },
    { name: "allow", params: { sslmode: "allow" } },
    { name: "prefer", params: { sslmode: "prefer" } },
    { name: "require", params: { sslmode: "require" } },
    { name: "verify_ca_system", params: { sslmode: "verify-ca", sslrootcert: "system" } },
    { name: "verify_full_system", params: { sslmode: "verify-full", sslrootcert: "system" } },
    { name: "verify_ca_root", params: { sslmode: "verify-ca", sslrootcert: rootPath } },
    { name: "verify_full_root", params: { sslmode: "verify-full", sslrootcert: rootPath } },
    ...(ip ? [{ name: "verify_full_wrong_name", params: { sslmode: "verify-full", sslrootcert: rootPath, host: "wrong-name.invalid", hostaddr: ip }, negative: true }] : []),
    { name: "direct_negotiation", params: { sslmode: "require", sslnegotiation: "direct" } },
  ];
}

/** One matrix on one path; exported for TL16 to re-run the plaintext cells. */
export async function matrix(p: PgPath, password: string, only?: string[]): Promise<Record<string, string>> {
  const chain = await handshake(tlsTarget(p), { showcerts: true });
  const root = chain.pems[chain.pems.length - 1];
  const f = await pemFile(root ? [root] : []);
  const ip = (await $`dig +short ${p.host} A`.quiet().nothrow()).stdout.toString().trim().split("\n").filter((l) => /^\d+\./.test(l)).pop() ?? "";
  const res: Record<string, string> = {};
  try {
    for (const c of cells(f.path, ip)) {
      if (only && !only.includes(c.name)) continue;
      const r = await psql(p, password, c.params, SELF_SSL_SQL);
      res[c.name] = r.ok ? `ok ${r.out}` : `fail: ${r.err}`;
    }
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
  return res;
}

const mod: TestModule = {
  id: "TL12",
  title: "Postgres: libpq sslmode matrix per path (plaintext, verify-ca/full with system and platform roots, direct negotiation)",
  where: "local",
  requires: ["db", "openssl"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL12", title: mod.title, status: "skip", detail: "no project ref" }];
    const out: TestResult[] = [];
    for (const p of await pgPaths(ctx)) {
      const id = `TL12-${p.name}`;
      if (!p.reachable) {
        out.push({ id, title: `${p.name}: sslmode matrix`, status: "skip", detail: p.why });
        continue;
      }
      const res = await matrix(p, ctx.dbPassword);
      // The prescribed path must work and the negative control must not.
      const prescribed = res.verify_full_root?.startsWith("ok");
      const negativeHeld = res.verify_full_wrong_name === undefined || res.verify_full_wrong_name.startsWith("fail");
      out.push({
        id,
        title: `${p.name} (${p.host}:${p.port}): sslmode matrix`,
        status: prescribed && negativeHeld ? "pass" : "fail",
        detail: Object.entries(res).map(([k, v]) => `${k}: ${v}`).join("; "),
        measurements: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.startsWith("ok") ? v.replace(/^ok /, "ok ").slice(0, 60) : v.slice(0, 90)])),
      });
    }
    return out;
  },
};
export default mod;
