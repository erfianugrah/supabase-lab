/**
 * TL21 - outbound TLS from an Edge Function: the same target list as TL20,
 * fetched by the Deno runtime.
 *
 * Deploys one function through the Management API (server-side bundling,
 * edge-function-limits' helper), invokes it once, and deletes it. The
 * function fetches every target and returns status or the error text; the
 * howsmyssl echo shows what the runtime offers. A runtime that connects to
 * `expired` or `wrong_host` does not verify certificates. DESTRUCTIVE
 * (deploys and deletes a function).
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { TestModule } from "../../../harness/src/types";
import { deployViaApi, landedPatiently } from "../../edge-function-limits/lib/ef";
import { OUTBOUND, summariseHowsMySsl, verdict } from "../lib/outbound";

const SLUG = "tl21-tls-outbound";

const SOURCE = `Deno.serve(async (req) => {
  const { targets } = await req.json();
  const out = [];
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(t.url, { signal: AbortSignal.timeout(12000) });
      const body = t.id === "howsmyssl" ? await r.text() : (await r.arrayBuffer(), "");
      out.push({ id: t.id, status: r.status, ms: Date.now() - t0, body: body.slice(0, 6000) });
    } catch (e) {
      out.push({ id: t.id, status: 0, ms: Date.now() - t0, err: String(e).slice(0, 300) });
    }
  }
  return Response.json(out);
});
`;

interface Row {
  id: string;
  status: number;
  err?: string;
  body?: string;
}

const mod: TestModule = {
  id: "TL21",
  title: "Outbound TLS from an Edge Function: what Deno offers, and whether it refuses bad protocols, suites and certificates",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(ctx) {
    const dep = await deployViaApi(ctx, SLUG, [{ name: "index.ts", content: SOURCE }], { entrypoint_path: "index.ts", verify_jwt: false });
    const land = await landedPatiently(ctx, SLUG);
    if (!land.present) return [{ id: "TL21", title: mod.title, status: "fail", detail: `deploy HTTP ${dep.status} ${dep.error}; GET function ${land.status}` }];
    try {
      let rows: Row[] = [];
      let last = "";
      // A fresh deploy can 404/503 for a few seconds while it propagates.
      for (let i = 0; i < 10 && !rows.length; i++) {
        try {
          const r = await fetch(`https://${ctx.apiHost}/functions/v1/${SLUG}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${ctx.anonKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ targets: OUTBOUND }),
            signal: AbortSignal.timeout(150_000),
          });
          if (r.ok) rows = (await r.json()) as Row[];
          else last = `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`;
        } catch (e) {
          last = String(e).slice(0, 120);
        }
        if (!rows.length) await Bun.sleep(5000);
      }
      if (!rows.length) return [{ id: "TL21", title: mod.title, status: "fail", detail: `invoke never succeeded: ${last}` }];
      const m: Record<string, string | number> = {};
      const notes: string[] = [];
      let mismatches = 0;
      for (const t of OUTBOUND) {
        const r = rows.find((x) => x.id === t.id);
        const got = verdict(r?.status ?? 0);
        if (got !== t.expect) mismatches++;
        m[t.id] = r?.status ? `${r.status}` : `fail: ${(r?.err ?? "missing").slice(0, 70)}`;
        notes.push(`${t.id}: ${got}${r?.status ? ` ${r.status}` : ` (${(r?.err ?? "").slice(0, 80)})`}, expected ${t.expect}`);
        if (t.id === "howsmyssl" && r?.status === 200) Object.assign(m, summariseHowsMySsl(r.body ?? ""));
      }
      return [{ id: "TL21", title: mod.title, status: mismatches ? "fail" : "pass", detail: `${mismatches} target(s) where the runtime differs from a verifying modern client. ${notes.join("; ")}`, measurements: { mismatches, ...m } }];
    } finally {
      await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${SLUG}`).catch(() => {});
    }
  },
};
export default mod;
