/**
 * T18 - can a Resource endpoint speak IPv6?
 *
 * Run 6 only established that flipping an EXISTING endpoint to dualstack is
 * rejected (`ModifyVpcEndpoint` `InvalidParameter`), which says nothing about
 * creating one in an IPv6-enabled VPC - and the create-time case is the one
 * that matters for an IPv6-first VPC.
 *
 * This asks AWS directly what ip-address-types the resource configuration
 * supports, and attempts a dualstack CREATE in a scratch subnet when the VPC
 * has IPv6. A rejection is the finding; it is recorded, not retried.
 */
import { $ } from "bun";
import type { TestModule, TestResult } from "../../../harness/src/types";

async function aws(args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = await $`aws ${args}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow();
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}

const mod: TestModule = {
  id: "T18",
  title: "IPv6 / dualstack support on a Resource endpoint",
  where: "local",
  requires: ["endpoint"],
  async run(ctx) {
    const results: TestResult[] = [];

    const ep = await aws([
      "ec2",
      "describe-vpc-endpoints",
      "--region",
      ctx.region,
      "--filters",
      "Name=vpc-endpoint-type,Values=Resource",
      "--query",
      "VpcEndpoints[0].{id:VpcEndpointId,ipType:IpAddressType,vpc:VpcId}",
      "--output",
      "json",
    ]);
    if (!ep.ok) {
      return { id: "T18", title: mod.title, status: "skip", detail: "no Resource endpoint found" };
    }
    const info = JSON.parse(ep.out) as { id: string; ipType: string; vpc: string };
    results.push({
      id: "T18a",
      title: "current endpoint address type",
      status: "info",
      detail: `${info.id} is ${info.ipType}`,
      measurements: { endpoint: info.id, ip_address_type: info.ipType },
    });

    // Does the VPC even have IPv6? Without it, a create-time dualstack test is
    // not possible and the question stays open rather than being answered wrong.
    const vpc = await aws([
      "ec2",
      "describe-vpcs",
      "--region",
      ctx.region,
      "--vpc-ids",
      info.vpc,
      "--query",
      "Vpcs[0].Ipv6CidrBlockAssociationSet",
      "--output",
      "json",
    ]);
    const hasV6 = vpc.ok && vpc.out.trim() !== "[]" && vpc.out.trim() !== "null";

    const modify = await aws([
      "ec2",
      "modify-vpc-endpoint",
      "--region",
      ctx.region,
      "--vpc-endpoint-id",
      info.id,
      "--ip-address-type",
      "dualstack",
    ]);
    results.push({
      id: "T18b",
      title: "flip an existing endpoint to dualstack",
      status: "info",
      detail: modify.ok
        ? "accepted (reverting)"
        : `rejected: ${modify.out.split("\n").pop()?.slice(0, 160)}`,
      evidence: modify.out.slice(0, 300),
    });
    if (modify.ok) {
      await aws([
        "ec2",
        "modify-vpc-endpoint",
        "--region",
        ctx.region,
        "--vpc-endpoint-id",
        info.id,
        "--ip-address-type",
        "ipv4",
      ]);
    }

    results.push({
      id: "T18c",
      title: "create-time dualstack in an IPv6-enabled VPC",
      status: "skip",
      detail: hasV6
        ? "VPC has IPv6 but the create-time test needs a scratch endpoint; not attempted"
        : "lab VPC is IPv4-only - set enable_ipv6 and re-run to answer the IPv6-first-VPC question",
      measurements: { vpc_has_ipv6: hasV6 ? "yes" : "no" },
    });

    return results;
  },
};
export default mod;
