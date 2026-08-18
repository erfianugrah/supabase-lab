/**
 * M07 - the invoice is a dataset, if you parse it: settlement-layer
 * reconciliation.
 *
 * "A monthly PDF is not a dataset" - true as far as it goes, but the PDF is
 * also the only place per-ref gross usage lands with legal weight. This
 * module closes the loop: parse the invoice's per-ref lines, join them
 * against the live org, and reconcile billed compute-hours against the
 * billing window.
 *
 *   M07-control  the PDF parses and yields per-ref rows (count + total
 *                compute hours).
 *   M07a         join coverage: which invoiced refs are live projects
 *                (names resolved), which are deleted.
 *   M07b         reconciliation: for live projects, billed compute hours vs
 *                the billing window - the per-ref share of the window.
 *
 * Gated on PVLAB_INVOICE_PDF (path to an invoice PDF on this machine).
 * pdftotext must be installed. Read-only against the platform.
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

interface ProjectRow {
  id?: string;
  ref?: string;
  name?: string;
  status?: string;
}

interface InvoiceLine {
  ref: string;
  quantity: number;
  rate: number;
  amount: number;
}

const mod: TestModule = {
  id: "M07",
  title: "Invoice reconciliation: per-ref lines joined against the live org",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const pdf = process.env.PVLAB_INVOICE_PDF;
    const titles: Record<string, string> = {
      "M07-control": "parse per-ref lines from the invoice PDF",
      "M07a": "join coverage against the live org",
      "M07b": "billed-hours reconciliation",
    };
    if (!pdf) {
      return Object.entries(titles).map(([id, title]) => ({
        id,
        title,
        status: "skip" as const,
        detail: "missing env: PVLAB_INVOICE_PDF",
      }));
    }

    const results: TestResult[] = [];
    try {
      // ---- control: parse ----
      const text = await $`pdftotext -layout ${pdf} -`.text();
      // per-ref rows: 20-char ref, quantity, $rate, $amount
      const lineRe = /^([a-z0-9]{20})\s+(\d+(?:\.\d+)?)\s+\$?([\d.]+)\s+\$?([\d.]+)\s*$/gm;
      const lines: InvoiceLine[] = [];
      for (const m of text.matchAll(lineRe)) {
        lines.push({ ref: m[1]!, quantity: Number(m[2]), rate: Number(m[3]), amount: Number(m[4]) });
      }
      const computeLines = lines.filter((l) => l.rate === 0.01344 || l.rate === 0.0206);
      const totalComputeHours = computeLines.reduce((s, l) => s + l.quantity, 0);
      results.push({
        id: "M07-control",
        title: titles["M07-control"]!,
        status: lines.length > 0 ? "pass" : "fail",
        detail: lines.length === 0 ? "no per-ref lines parsed - pdftotext layout changed?" : undefined,
        measurements: {
          per_ref_lines: lines.length,
          compute_lines: computeLines.length,
          total_compute_hours: Math.round(totalComputeHours * 100) / 100,
        },
      });
      if (lines.length === 0) return results;

      // ---- M07a: join coverage ----
      const list = await mgmt(ctx, "GET", "/projects");
      const projects = (Array.isArray(list.json) ? list.json : []) as ProjectRow[];
      const live = new Map(projects.map((p) => [p.ref ?? p.id ?? "", p.name ?? ""]));
      const refs = [...new Set(lines.map((l) => l.ref))];
      const matched = refs.filter((r) => live.has(r));
      const gone = refs.filter((r) => !live.has(r));
      results.push({
        id: "M07a",
        title: titles["M07a"]!,
        status: "info",
        measurements: {
          invoice_refs: refs.length,
          live_projects: live.size,
          matched: matched.length,
          deleted_since_invoice: gone.length,
        },
        evidence: matched.map((r) => `${r} -> ${live.get(r)}`).join("\n").slice(0, 400),
      });

      // ---- M07b: reconciliation ----
      // The invoice window (Jul 14 - Aug 7 2026) is 25 days = 600 hours.
      const windowHours = 600;
      const recon = computeLines
        .filter((l) => live.has(l.ref))
        .map((l) => ({
          ref: l.ref,
          name: live.get(l.ref) ?? "",
          billed_hours: l.quantity,
          share_of_window: Math.round((l.quantity / windowHours) * 1000) / 10,
        }));
      results.push({
        id: "M07b",
        title: titles["M07b"]!,
        status: "info",
        measurements: {
          reconciled_projects: recon.length,
          max_share_pct: recon.length ? Math.max(...recon.map((r) => r.share_of_window)) : 0,
        },
        evidence: recon.map((r) => `${r.name}: ${r.billed_hours}h of ${windowHours}h window (${r.share_of_window}%)`).join("\n"),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of Object.keys(titles)) {
        if (!results.some((r) => r.id === id)) results.push({ id, title: titles[id]!, status: "fail", detail: `threw: ${msg}` });
      }
    }
    return results;
  },
};
export default mod;
