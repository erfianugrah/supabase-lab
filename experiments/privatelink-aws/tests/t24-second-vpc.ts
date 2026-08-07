/**
 * T24 - reaching the endpoint from a SECOND VPC.
 *
 * AWS's own docs assert a Resource-type VPC endpoint is scoped to the VPC it
 * was created in, and that peering alone does not extend Lattice consumption
 * to a peer network - cited from documentation, never tested. `vpc2.tf`
 * (enable_second_vpc) gives the peer network a full, correctly-wired path:
 * peering, routes both ways, an opened security-group rule, AND the private
 * hosted zone associated with the second VPC too - so an unreachable result
 * rules out "the firewall/DNS blocked it" as the explanation and leaves only
 * the claim actually under test (the endpoint's own per-VPC scoping).
 *
 * Probes from a Lambda placed IN the second VPC, the same way T15/T19/T21
 * probe from inside the lab VPC: the orchestrator itself cannot reach a
 * private endpoint at all, so the control has to run where the question is.
 * Whether the PHZ name resolves there at all is itself part of the finding -
 * DNS association and the endpoint's per-VPC scoping are two separate AWS
 * mechanisms, and this is the one test that can tell them apart.
 *
 * Unreachable is the doc's claim holding up, not a test failure - see
 * t02-connectivity.ts for the same probe shape proving the OPPOSITE claim
 * inside the lab VPC.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { invokeProbe } from "../lib/lambda-probe";

/** DNS lookup failures read very differently from a refused/timed-out TCP connect. */
function looksLikeDnsFailure(error: string | undefined): boolean {
  return !!error && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error);
}

const mod: TestModule = {
  id: "T24",
  title: "Endpoint reachability from a second, peered VPC",
  where: "local",
  requires: ["second-vpc"],
  async run(ctx): Promise<TestResult> {
    const functionName = ctx.endpoints.second_vpc_lambda;
    if (!functionName) {
      return {
        id: "T24",
        title: mod.title,
        status: "skip",
        detail:
          "enable_second_vpc is off (or its probe Lambda is absent) - set it true and apply to exercise this",
      };
    }

    const res = await invokeProbe(ctx.region, {}, functionName);
    if (!res.results?.length) {
      return {
        id: "T24",
        title: mod.title,
        status: "info",
        detail: "probe returned no results",
        evidence: res.raw.slice(0, 300),
      };
    }

    const resolves = !res.results.some((r) => looksLikeDnsFailure(r.error));
    const okPorts = res.results.filter((r) => r.ok).map((r) => r.port);

    return {
      id: "T24",
      title: mod.title,
      status: "info",
      detail:
        okPorts.length > 0
          ? `reachable from the second VPC on ${okPorts.join(",")} - peering DOES carry the endpoint here, contradicting the doc's per-VPC claim`
          : resolves
            ? "PHZ name resolves in the second VPC but every connection failed - the endpoint stays per-VPC even with full peering, routing and DNS association in place"
            : "PHZ name does not resolve in the second VPC - the per-VPC claim holds at the DNS layer, before the endpoint's own scoping is even reached",
      measurements: {
        function_name: functionName,
        phz_resolves: String(resolves),
        port_5432_ok: String(res.results.find((r) => r.port === 5432)?.ok ?? false),
        port_6543_ok: String(res.results.find((r) => r.port === 6543)?.ok ?? false),
      },
      evidence: JSON.stringify(res.results),
    };
  },
};
export default mod;
