/**
 * R03 - every API request transits the caller-nearest Cloudflare PoP.
 *
 * The residency doc claims (measured ad hoc 2026-08-10 from Singapore
 * against eu-central-1): REST and Storage responses carry `server:
 * cloudflare` and a `cf-ray` whose PoP code is the caller's nearest (SIN),
 * regardless of project region. This re-measures it on the record against a
 * Zurich (eu-central-2) project.
 *
 * Asserts server=cloudflare on both surfaces; the PoP code itself is `info`
 * (it depends on where the runner sits, which is a property of the vantage,
 * not the platform).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { getKeys, h } from "../lib";

const mod: TestModule = {
  id: "R03",
  title: "Cloudflare edge in front of project APIs",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const keys = await getKeys(ctx);
    if (!keys.anon) {
      return [{ id: "R03a", title: "edge headers", status: "fail", detail: "could not fetch anon key via Management API" }];
    }
    const headers = { apikey: keys.anon, Authorization: `Bearer ${keys.anon}` };

    async function probe(path: string) {
      const res = await fetch(`https://${ctx.apiHost}${path}`, { headers });
      await res.arrayBuffer(); // drain
      return {
        status: res.status,
        server: h(res.headers, "server"),
        cfRay: h(res.headers, "cf-ray"),
        pop: h(res.headers, "cf-ray").split("-")[1] ?? "",
      };
    }

    const rest = await probe("/rest/v1/");
    const storage = await probe("/storage/v1/bucket");

    const measurements: Record<string, string | number> = {
      rest_status: rest.status,
      rest_server: rest.server,
      rest_pop: rest.pop,
      storage_status: storage.status,
      storage_server: storage.server,
      storage_pop: storage.pop,
    };

    const ok = rest.server === "cloudflare" && storage.server === "cloudflare";
    return [
      {
        id: "R03a",
        title: this.title,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `REST and Storage both served by Cloudflare; PoP for this vantage: REST=${rest.pop || "?"}, Storage=${storage.pop || "?"}`
          : `server header not cloudflare: REST="${rest.server}", Storage="${storage.server}"`,
        measurements,
      },
    ];
  },
};
export default mod;
