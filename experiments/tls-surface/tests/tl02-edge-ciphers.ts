/**
 * TL02 - every TLS 1.2 cipher suite each HTTPS name accepts, and the TLS 1.3
 * suites.
 *
 * One handshake per suite this OpenSSL build can offer (~155 at
 * @SECLEVEL=0); a suite counts as accepted only if the server picked exactly
 * it. The four ECDHE CBC suites with SHA-2 MACs the edge offered on
 * 2026-10-02 get their own measurement columns (`ECDHE-RSA-AES128-SHA256` =
 * accepted | refused:alertNN), so `pvlab --diff` between two runs shows a
 * change to the edge's cipher list per suite and nothing else.
 *
 * A security scanner's "CBC suites enabled" finding on these names would list
 * what this row lists. Read-only.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { ECDHE_CBC_SHA2, edgeTargets, enumerate, type Target } from "../lib/tls";

export async function cipherRows(prefix: string, targets: Target[]): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of targets) {
    const e = await enumerate(t);
    if (!e.accepted.length && Object.values(e.tls13).every((v) => v !== "accepted")) {
      out.push({ id: `${prefix}-${t.role}`, title: `${t.host}: cipher suites`, status: "info", detail: `no suite accepted - name not served from here (${e.anomalies[0] ?? "all refused"})` });
      continue;
    }
    const dep = ECDHE_CBC_SHA2.map((c) => `${c} ${e.ecdheCbc[c]}`).join(", ");
    out.push({
      id: `${prefix}-${t.role}`,
      title: `${t.host}: TLS 1.2 suites accepted (of ${e.offered} offered), TLS 1.3 suites`,
      status: "info",
      detail: `${e.accepted.length} TLS 1.2 suites accepted, ${e.cbcAccepted.length} of them CBC [${e.cbcAccepted.join(", ") || "none"}]; ECDHE CBC SHA-2 four: ${dep}; TLS 1.3: ${Object.entries(e.tls13).map(([k, v]) => `${k} ${v}`).join(", ")}${e.anomalies.length ? `; ANOMALIES ${e.anomalies.slice(0, 5).join(", ")}` : ""}`,
      measurements: {
        offered: e.offered,
        accepted_count: e.accepted.length,
        cbc_accepted_count: e.cbcAccepted.length,
        accepted: e.accepted.join(":"),
        ...e.ecdheCbc,
        ...e.tls13,
        anomalies: e.anomalies.length,
      },
    });
  }
  return out;
}

const mod: TestModule = {
  id: "TL02",
  title: "HTTP edge: cipher suite enumeration per project hostname",
  where: "local",
  requires: ["openssl"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL02", title: mod.title, status: "skip", detail: "no project ref" }];
    return cipherRows("TL02", await edgeTargets(ctx));
  },
};
export default mod;
