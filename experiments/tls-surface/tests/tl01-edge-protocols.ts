/**
 * TL01 - which TLS protocol versions each HTTPS name of a project accepts.
 *
 * The expectation is TLS 1.2 and 1.3 only; this checks it per name: the
 * project API host, the Storage host (the S3 endpoint lives there), the
 * legacy `<ref>.functions.supabase.co` form, the Management API as a
 * control, and an existing custom domain when PVLAB_ENDPOINT_CUSTOM_DOMAIN
 * names one (TL17 creates its own, named by PVLAB_ENDPOINT_CUSTOM_HOST).
 *
 * One handshake per protocol with the client lowered to @SECLEVEL=0 for 1.0
 * and 1.1, so a refusal is the server's (alert 70) and not OpenSSL 3 refusing
 * to offer. Read-only.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { edgeTargets, PROTOS, protocols, type Target } from "../lib/tls";

export async function protocolRows(prefix: string, targets: Target[]): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const t of targets) {
    const p = await protocols(t);
    const r = p.result;
    const modernOnly = r["1.0"] !== "ok" && r["1.1"] !== "ok" && r["1.2"] === "ok" && r["1.3"] === "ok";
    const unreachable = PROTOS.every((v) => r[v] === "no-connect" || r[v] === "timeout");
    out.push({
      id: `${prefix}-${t.role}`,
      title: `${t.host}: TLS protocol versions accepted`,
      status: unreachable ? "info" : modernOnly ? "pass" : "fail",
      detail: unreachable
        ? `${t.host} did not connect (${r["1.3"]}) - name not served from here`
        : PROTOS.map((v) => `TLS ${v} ${r[v]}${p.chosen[v] ? ` (${p.chosen[v]})` : ""}`).join(", "),
      measurements: Object.fromEntries(PROTOS.flatMap((v) => [[`tls${v.replace(".", "")}`, r[v]], [`tls${v.replace(".", "")}_cipher`, p.chosen[v] || "-"]])),
    });
  }
  return out;
}

const mod: TestModule = {
  id: "TL01",
  title: "HTTP edge: TLS protocol versions per project hostname",
  where: "local",
  requires: ["openssl"],
  async run(ctx) {
    if (!ctx.ref) return [{ id: "TL01", title: mod.title, status: "skip", detail: "no project ref" }];
    return protocolRows("TL01", await edgeTargets(ctx));
  },
};
export default mod;
