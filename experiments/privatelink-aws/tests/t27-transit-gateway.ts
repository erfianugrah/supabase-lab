/**
 * T27 - reaching the endpoint over a TRANSIT GATEWAY instead of peering.
 *
 * Same second VPC and probe Lambda T24 already built (enable_second_vpc) -
 * the PHZ association (aws_route53_zone_association.db_second) and the
 * endpoint security-group rule for that VPC's CIDR
 * (aws_security_group_rule.endpoint_from_second), both in vpc2.tf, are
 * per-VPC and per-CIDR respectively and apply no matter which transport
 * carries the traffic, so neither needs duplicating. What changes is the
 * route: `enable_transit_gateway` (tgw.tf) builds a transit gateway with an
 * attachment for each VPC and routes both ways, and vpc2.tf makes the
 * peering connection MUTUALLY EXCLUSIVE with it - turning the transit
 * gateway on tears the peering connection down rather than adding a second
 * path alongside it.
 *
 * That tofu-level exclusivity is necessary but not sufficient: if it ever
 * regresses (a stale peering connection left in state, a partial apply), a
 * reachable result here would prove nothing about transit gateways
 * specifically - traffic could be riding peering instead. So this test does
 * NOT trust the toggle. It independently checks the peering connection's own
 * AWS state and the transit gateway attachment's own AWS state, and only
 * reports a transport-attributed result when EXACTLY ONE of the two is
 * actually up. Both up, or neither up, is ambiguous or unconfigured and the
 * test SKIPS rather than assuming - the failure mode that matters here is a
 * false pass, not a missed measurement.
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { invokeProbe } from "../lib/lambda-probe";

async function aws(args: string[]): Promise<string> {
  return await $`aws ${args}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow()
    .text()
    .catch(() => "");
}

/** "active" is the only healthy state for an accepted, same-account peering. */
async function peeringState(ctx: Ctx): Promise<string> {
  const out = await aws([
    "ec2", "describe-vpc-peering-connections", "--region", ctx.region,
    "--filters", "Name=tag:Name,Values=supabase-lab-peering",
    "--query", "VpcPeeringConnections[0].Status.Code", "--output", "text",
  ]);
  return out.trim() || "none";
}

async function tgwAttachmentState(ctx: Ctx): Promise<string> {
  const out = await aws([
    "ec2", "describe-transit-gateway-attachments", "--region", ctx.region,
    "--filters", "Name=tag:Name,Values=supabase-lab-tgw-second",
    "--query", "TransitGatewayAttachments[0].State", "--output", "text",
  ]);
  return out.trim() || "none";
}

function looksLikeDnsFailure(error: string | undefined): boolean {
  return !!error && /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error);
}

const mod: TestModule = {
  id: "T27",
  title: "Endpoint reachability from the second VPC over a transit gateway",
  where: "local",
  requires: ["second-vpc"],
  async run(ctx): Promise<TestResult> {
    const functionName = ctx.endpoints.second_vpc_lambda;
    if (!functionName) {
      return {
        id: "T27",
        title: mod.title,
        status: "skip",
        detail:
          "enable_second_vpc is off (or its probe Lambda is absent) - set it and enable_transit_gateway true and apply to exercise this",
      };
    }

    const [peering, tgw] = await Promise.all([peeringState(ctx), tgwAttachmentState(ctx)]);
    const peeringUp = /^(active|pending-acceptance|provisioning)$/i.test(peering);
    const tgwUp = /^available$/i.test(tgw);

    if (peeringUp && tgwUp) {
      return {
        id: "T27",
        title: mod.title,
        status: "skip",
        detail:
          `both the peering connection (${peering}) and the transit gateway attachment (${tgw}) are up - ` +
          "traffic could ride either path, so a reachability result would not prove anything about the transit gateway " +
          "specifically. The mutual exclusivity in vpc2.tf/tgw.tf did not hold for this state - destroy the peering " +
          "connection (or re-apply with enable_transit_gateway=true, which tears it down) before running this again.",
        measurements: { peering_state: peering, tgw_attachment_state: tgw },
      };
    }
    if (!peeringUp && !tgwUp) {
      return {
        id: "T27",
        title: mod.title,
        status: "skip",
        detail: `neither transport is up (peering=${peering}, transit gateway attachment=${tgw}) - enable_transit_gateway is off, or the apply has not completed`,
        measurements: { peering_state: peering, tgw_attachment_state: tgw },
      };
    }
    if (peeringUp && !tgwUp) {
      return {
        id: "T27",
        title: mod.title,
        status: "skip",
        detail: `only the peering connection is up (${peering}) - the transit gateway is not attached, so this would just re-run T24, not test a transit gateway`,
        measurements: { peering_state: peering, tgw_attachment_state: tgw },
      };
    }

    // Only remaining case: transit gateway up, peering down - the one
    // unambiguous state this test exists to measure.
    const transport = "transit-gateway";
    const res = await invokeProbe(ctx.region, {}, functionName);
    if (!res.results?.length) {
      return {
        id: "T27",
        title: mod.title,
        status: "info",
        detail: `transport confirmed as ${transport}, but the probe returned no results`,
        measurements: { transport, peering_state: peering, tgw_attachment_state: tgw },
        evidence: res.raw.slice(0, 300),
      };
    }

    const resolves = !res.results.some((r) => looksLikeDnsFailure(r.error));
    const okPorts = res.results.filter((r) => r.ok).map((r) => r.port);

    return {
      id: "T27",
      title: mod.title,
      status: "info",
      detail:
        okPorts.length > 0
          ? `reachable from the second VPC over the transit gateway on ${okPorts.join(",")} - the transit gateway carries the endpoint here`
          : resolves
            ? "PHZ name resolves in the second VPC over the transit gateway but every connection failed - the endpoint stays per-VPC even over a different transport"
            : "PHZ name does not resolve in the second VPC over the transit gateway - the per-VPC claim holds at the DNS layer",
      measurements: {
        transport,
        peering_state: peering,
        tgw_attachment_state: tgw,
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
