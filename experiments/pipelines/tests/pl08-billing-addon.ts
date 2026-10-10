/**
 * PL08 - the Pipelines billing line as the Management API shows it.
 *
 * Docs claim: Pro and Team pay 0.053 USD per hour per configured pipeline,
 * "including while stopped"; deleting the pipeline ends the charge
 * (https://supabase.com/docs/guides/platform/manage-your-usage/pipelines).
 * Whether charges continue while stopped is billing behaviour that only an
 * invoice or usage export shows; no pipeline can be created here (PL01), so it
 * is NOT measured. What the API does show:
 *
 *   PL08a  `GET /v1/projects/{ref}/billing/addons` lists an `etl_pipeline`
 *          add-on variant and its price; the rate is compared with the docs'
 *          0.053 USD per hour.
 *   PL08b  whether a token can attach and detach that add-on on a project, and
 *          what the listing shows while attached. The add-on is attached for
 *          seconds and removed in `finally`; it bills per hour, so the cost is
 *          a fraction of a cent. Attaching it does not create a pipeline.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";
import { ensureFixture, withCleanup } from "../lib/fixture.js";
import { lbl } from "../lib/util.js";

interface Addons {
  selected_addons?: Array<{ type: string; variant?: { id?: string } }>;
  available_addons?: Array<{ type: string; variants?: Array<{ id: string; price?: { description?: string; amount?: number; interval?: string; type?: string } }> }>;
}

const mod: TestModule = {
  id: "PL08",
  title: "PL08 - etl_pipeline billing add-on",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const fx = await ensureFixture(ctx);
    const ref = fx.state.ref;
    const list = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
    const a = (list.json ?? {}) as Addons;
    const etl = a.available_addons?.find((x) => x.type === "etl_pipeline");
    const v = etl?.variants?.[0];
    results.push({
      id: "PL08a",
      title: "PL08a: billing add-on listing carries an etl_pipeline variant",
      status: "info",
      detail: etl ? `variant ${v?.id}, ${v?.price?.description}` : "no etl_pipeline add-on in the listing",
      measurements: {
        list_http: list.status,
        etl_variant: v?.id ?? "none",
        price_description: lbl(v?.price?.description ?? "none"),
        price_amount: v?.price?.amount ?? -1,
        price_interval: v?.price?.interval ?? "none",
        price_type: v?.price?.type ?? "none",
        docs_rate_usd_per_hour: 0.053,
        implied_monthly_usd_at_730h: v?.price?.amount ? Math.round(v.price.amount * 730 * 100) / 100 : -1,
        selected_before: lbl((a.selected_addons ?? []).map((s) => s.type).join(" ") || "none"),
      },
    });
    if (!v) return results;

    let attached = false;
    try {
      const p = await mgmt(ctx, "PATCH", `/projects/${ref}/billing/addons`, {
        addon_type: "etl_pipeline",
        addon_variant: v.id,
      });
      attached = p.status < 300;
      const after = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
      const sel = ((after.json ?? {}) as Addons).selected_addons ?? [];
      results.push({
        id: "PL08b",
        title: "PL08b: a token attaches and detaches the etl_pipeline add-on",
        status: "info",
        detail: attached ? `PATCH ${p.status}; listing shows ${sel.map((s) => s.type).join(",")}` : `PATCH ${p.status}: ${p.text.slice(0, 160)}`,
        measurements: {
          patch_http: p.status,
          patch_body: lbl(p.text, 160),
          selected_while_attached: lbl(sel.map((s) => `${s.type}:${s.variant?.id ?? ""}`).join(" ") || "none"),
        },
      });
    } finally {
      if (attached) {
        const d = await mgmt(ctx, "DELETE", `/projects/${ref}/billing/addons/${v.id}`);
        const fin = await mgmt(ctx, "GET", `/projects/${ref}/billing/addons`);
        const left = ((fin.json ?? {}) as Addons).selected_addons?.some((s) => s.type === "etl_pipeline") ?? false;
        results.push({
          id: "PL08c",
          title: "PL08c: the add-on detaches",
          status: d.status < 300 && !left ? "pass" : "fail",
          detail: `DELETE ${d.status}; still listed: ${left}`,
          measurements: { delete_http: d.status, still_selected: String(left) },
        });
      }
    }
    return results;
  },
};

export default withCleanup(mod, ["docker"]);
