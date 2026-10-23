/**
 * X04 - one token, two projects: the trust a tenant-per-project fan-out read
 * rests on.
 *
 * SIDE: two self-provisioned Pro-org projects in one region (lib/fanout.ts).
 * A's Auth issues the token; B registers A as a third-party issuer
 * (`oidc_issuer_url` = A's /auth/v1). VERIFIER: each project's Data API
 * (PostgREST). KEYS: each project's legacy anon JWT as `apikey`; the bearer is
 * the tenant user's A-issued access token.
 *
 *   X04a  setup facts: compute read back, Postgres version, seeded counts.
 *   X04b  control: before trust, B refuses tenant-a's token (expected 401 PGRST301).
 *   X04c  trust created on B; ms until the same token is accepted (500 ms poll).
 *   X04d  tenant-a's token reads only tenant-a rows on A and on B; counts equal the seed.
 *   X04e  tenant-b's token (also A-issued) reads only tenant-b rows on B.
 *   X04f  Edge Function deployed on A answers a fan-out read with both legs 200.
 *
 * DESTRUCTIVE: creates two projects; X99 deletes them.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { brief, callFn, codeOf, createTpa, deployFn, ensurePair, readAll, skipWithoutPro, until } from "../lib/fanout.js";
import { pageQuery } from "../lib/merge.js";

const tenants = (j: unknown) =>
  Array.isArray(j) ? [...new Set((j as { tenant_id?: string }[]).map((x) => x.tenant_id))].sort().join(",") : "";

const mod: TestModule = {
  id: "X04",
  title: "Fan-out: one A-issued token reads RLS-filtered rows from A and from B",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "X04");
    if (skip) return skip;
    const out: TestResult[] = [];
    const p = await ensurePair(ctx);

    out.push({
      id: "X04a",
      title: "Setup: two projects, seeded",
      status: "info",
      detail: `A ${p.a.compute}, B ${p.b.compute}; ${p.a.pgVersion}; tenant-a rows A=${p.seeded.a} B=${p.seeded.b} union=${p.seeded.all}; ${p.setupNotes.join("; ")}`,
      measurements: {
        compute_a: p.a.compute,
        compute_b: p.b.compute,
        pg_version: p.a.pgVersion,
        create_to_ready_s_a: Math.round(p.a.createMs / 1000),
        create_to_ready_s_b: Math.round(p.b.createMs / 1000),
        seeded_tenant_a_on_a: p.seeded.a,
        seeded_tenant_a_on_b: p.seeded.b,
        seeded_tenant_a_union: p.seeded.all,
        truth_rows: p.truth.length,
        cross_project_exact_ties: p.seeded.ties,
        same_ms_clusters_of_3: p.seeded.clusters,
      },
    });

    const pre = await readAll(p.b, p.tokA);
    out.push({
      id: "X04b",
      title: "Control: before trust, B refuses the A-issued token",
      status: pre.status === 401 ? "pass" : "fail",
      detail: `HTTP ${pre.status} ${codeOf(pre)}`,
      measurements: { status: pre.status, code: codeOf(pre) },
      evidence: brief(pre.body),
    });

    const tpa = await createTpa(ctx, p);
    p.tpaId = tpa.id;
    const acc = await until(() => readAll(p.b, p.tokA), (r) => r.status === 200, 90_000);
    out.push({
      id: "X04c",
      title: "Trust created on B (oidc_issuer_url = A); same token accepted",
      status: tpa.status === 201 && acc.ms >= 0 ? "pass" : "fail",
      detail: `create HTTP ${tpa.status}; accepted after ${acc.ms} ms (500 ms poll)`,
      measurements: { create_status: tpa.status, accept_ms: acc.ms, poll_ms: 500 },
      evidence: brief(tpa.text, 160),
    });

    const onA = await readAll(p.a, p.tokA);
    const onB = await readAll(p.b, p.tokA);
    const nA = Array.isArray(onA.json) ? onA.json.length : -1;
    const nB = Array.isArray(onB.json) ? onB.json.length : -1;
    out.push({
      id: "X04d",
      title: "tenant-a token: only tenant-a rows on A and on B, counts equal the seed",
      status: nA === p.seeded.a && nB === p.seeded.b && tenants(onA.json) === "tenant-a" && tenants(onB.json) === "tenant-a" ? "pass" : "fail",
      detail: `A ${nA}/${p.seeded.a} tenants=${tenants(onA.json)}; B ${nB}/${p.seeded.b} tenants=${tenants(onB.json)}`,
      measurements: { rows_a: nA, rows_b: nB, tenants_a: tenants(onA.json), tenants_b: tenants(onB.json) },
    });

    const bOnB = await readAll(p.b, p.tokB);
    out.push({
      id: "X04e",
      title: "tenant-b token (A-issued): only tenant-b rows on B",
      status: tenants(bOnB.json) === "tenant-b" ? "pass" : "fail",
      detail: `HTTP ${bOnB.status}, ${Array.isArray(bOnB.json) ? bOnB.json.length : -1} rows, tenants=${tenants(bOnB.json)}`,
      measurements: { status: bOnB.status, rows: Array.isArray(bOnB.json) ? bOnB.json.length : -1, tenants: tenants(bOnB.json) },
    });

    const dep = await deployFn(ctx, p.a);
    const body = {
      targets: [
        { name: "a", url: p.a.url, anon: p.a.anon, table: "fan_items" },
        { name: "b", url: p.b.url, anon: p.b.anon, table: "fan_items" },
      ],
      qs: pageQuery(50),
      limit: 50,
      policy: "all",
      timeoutMs: 5000,
    };
    let first = await callFn(p.a, p.tokA, body);
    const t0 = Date.now();
    while (!first.ok && Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 3000));
      first = await callFn(p.a, p.tokA, body);
    }
    const truth50 = p.truth.slice(0, 50).map((r) => r.id).join(",");
    out.push({
      id: "X04f",
      title: "Edge Function on A: fan-out read, both legs 200, page equals ground truth",
      status: dep.status < 300 && first.ok && first.rows.map((r) => r.id).join(",") === truth50 ? "pass" : "fail",
      detail: `deploy HTTP ${dep.status}; call HTTP ${first.status}, legs ${first.legs.map((l) => `${l.name}:${l.status}`).join(" ")}, ${first.rows.length} rows, region ${first.region || "?"} (x-sb-edge-region ${first.servedBy || "?"})`,
      measurements: { deploy_status: dep.status, call_status: first.status, rows: first.rows.length, fn_region: first.region, edge_region_header: first.servedBy },
      evidence: brief(first.raw ?? first.error ?? (dep.status >= 300 ? dep.text : ""), 200),
    });

    return out;
  },
};
export default mod;
