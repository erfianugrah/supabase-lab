/**
 * T28 - read replicas behind PrivateLink.
 *
 * Replicas are fully API-drivable - `POST /v1/projects/{ref}/read-replicas/setup`
 * with `{"read_replica_region": ...}` and `.../read-replicas/remove` - unlike
 * the AWS account association itself, so this is the one piece of the matrix
 * that needs no dashboard click at all once the endpoint already exists.
 * Three questions, none answerable from docs alone:
 *
 *   1. does a SECOND Lattice resource configuration appear for the replica?
 *      Checked against AWS RAM directly (a resource count before/after), not
 *      assumed from the setup call's 2xx - a 2xx that changes nothing is a
 *      real failure mode here too (see the vault-root-key V03 precedent).
 *   2. does the replica get its own database hostname? The published /v1
 *      response shape for a replica has not been observed live, so this
 *      looks for a hostname-shaped string in the setup response rather than
 *      asserting one specific field name as fact.
 *   3. does the EXISTING endpoint/PHZ reach it at all? Probed from inside
 *      the VPC via the same Lambda T02/T24/T27 use, given whatever candidate
 *      host (2) found - T24 already showed a Resource endpoint is scoped to
 *      what it was explicitly built for, so a replica's own configuration
 *      would not automatically ride the primary's endpoint.
 *
 * A replica bills for as long as it exists, so removal is UNCONDITIONAL -
 * try/finally, regardless of whether the questions above were even
 * answerable - and the finally VERIFIES the removal by re-checking the RAM
 * resource count rather than trusting the remove call's status code, the
 * same lesson `aws_vpclattice_service_network_resource_association`'s
 * inconsistent-apply note already taught this experiment (lattice.tf): a 2xx
 * does not mean the resource is gone.
 *
 * `enable_read_replica` (replica.tf) gates a second consumer endpoint for
 * the replica's own resource configuration, once question 1 answers yes and
 * that ARN is known - this test itself is gated the same way every other
 * billed/destructive probe in this experiment is, by `requires` capabilities
 * plus `--destructive`, not by a second copy of the toggle.
 *
 * DESTRUCTIVE: creates and removes a real, billed read replica.
 */
import { $ } from "bun";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";
import { invokeProbe } from "../lib/lambda-probe";

async function ramResourceCount(ctx: Ctx): Promise<number | null> {
  const out = await $`aws ram list-resources --resource-owner OTHER-ACCOUNTS --region ${ctx.region} --query ${"length(resources)"} --output text`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow()
    .text()
    .catch(() => "");
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Look for a hostname-shaped string anywhere in the response rather than
 * pinning to one field - the exact shape of a read-replica response has
 * never been observed live in this experiment, so asserting a specific key
 * would be a guess dressed up as a fact.
 */
function findHostname(text: string): string | undefined {
  const m = text.match(/"[a-z0-9_.]*host[a-z0-9_.]*"\s*:\s*"([a-z0-9.-]+\.supabase\.co)"/i);
  return m?.[1];
}

const mod: TestModule = {
  id: "T28",
  title: "Read replica behind PrivateLink - second Lattice resource, own hostname, reachability",
  where: "local",
  requires: ["pat", "endpoint", "lambda"],
  destructive: true,
  async run(ctx): Promise<TestResult | TestResult[]> {
    // BASELINE GATE: if the primary path is not already reachable from
    // inside the VPC, a replica-reachability result would not mean anything
    // - and creating a billed replica to measure against a broken control
    // would be pure cost with no signal.
    const baseline = await invokeProbe(ctx.region, { port: 5432 });
    if (baseline.all_ok !== true) {
      return {
        id: "T28",
        title: mod.title,
        status: "skip",
        detail:
          "baseline in-VPC probe against the primary failed before creating the replica - no control, no conclusion",
      };
    }

    const baselineRamCount = await ramResourceCount(ctx);

    const setup = await mgmt(ctx, "POST", `/projects/${ctx.ref}/read-replicas/setup`, {
      read_replica_region: ctx.region,
    });

    if (setup.status >= 300) {
      return {
        id: "T28",
        title: mod.title,
        status: "info",
        detail: `read-replicas/setup rejected: HTTP ${setup.status}${setup.throttled ? " (throttled response)" : ""} - nothing was created, so there is nothing to remove`,
        evidence: setup.text.slice(0, 300),
      };
    }

    const results: TestResult[] = [];
    try {
      // Provisioning is asynchronous - poll for the RAM resource count to
      // move, bounded rather than a fixed sleep, so a slow provision does
      // not read as "no second resource appeared".
      let ramCount: number | null = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 300_000) {
        ramCount = await ramResourceCount(ctx);
        if (baselineRamCount !== null && ramCount !== null && ramCount > baselineRamCount) break;
        await Bun.sleep(15_000);
      }
      const gotSecondResource = baselineRamCount !== null && ramCount !== null && ramCount > baselineRamCount;

      results.push({
        id: "T28a",
        title: "second Lattice resource configuration for the replica",
        status: "info",
        detail:
          baselineRamCount === null || ramCount === null
            ? "could not read the RAM resource count (no AWS credentials in this environment) - unmeasured"
            : gotSecondResource
              ? `RAM resource count went ${baselineRamCount} -> ${ramCount} - the replica gets its own Lattice resource configuration`
              : `RAM resource count stayed at ${ramCount} within the window measured - no second Lattice resource appeared`,
        measurements: {
          baseline_ram_resources: baselineRamCount ?? "unknown",
          ram_resources_after: ramCount ?? "unknown",
        },
      });

      const host = findHostname(setup.text);
      results.push({
        id: "T28b",
        title: "replica's own database hostname",
        status: "info",
        detail: host
          ? `setup response carries a hostname-shaped field: ${host}`
          : "no hostname-shaped field found in the setup response - either the replica's hostname is not returned here, or it is not published yet",
        measurements: { hostname_found: String(!!host) },
        evidence: setup.text.slice(0, 500),
      });

      if (host) {
        const probe = await invokeProbe(ctx.region, { host, port: 5432 });
        const reachable = probe.results?.some((r) => r.ok) ?? false;
        results.push({
          id: "T28c",
          title: "existing endpoint/PHZ reaches the replica",
          status: "info",
          detail: reachable
            ? `${host} answered through the existing network path - the primary endpoint's reach extends to the replica`
            : `${host} did not answer through the existing network path - consistent with T24's finding that a Lattice resource is scoped to what it was explicitly built for`,
          measurements: { replica_host: host, reachable: String(reachable) },
          evidence: JSON.stringify(probe.results ?? probe.raw),
        });
      } else {
        results.push({
          id: "T28c",
          title: "existing endpoint/PHZ reaches the replica",
          status: "skip",
          detail: "no replica hostname found (see T28b) - nothing to probe",
        });
      }
    } finally {
      const remove = await mgmt(ctx, "POST", `/projects/${ctx.ref}/read-replicas/remove`, {
        read_replica_region: ctx.region,
      });

      // Verify the removal actually happened rather than trusting the
      // status code - poll the RAM resource count back to baseline.
      let removed = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 180_000) {
        const n = await ramResourceCount(ctx);
        if (baselineRamCount !== null && n !== null && n <= baselineRamCount) {
          removed = true;
          break;
        }
        await Bun.sleep(15_000);
      }

      results.push({
        id: "T28d",
        title: "replica removal verified",
        status: removed ? "pass" : "fail",
        detail: removed
          ? "RAM resource count returned to baseline - the replica's resources are gone"
          : `remove POST returned HTTP ${remove.status} but the RAM resource count never returned to baseline within the window - THE REPLICA MAY STILL BE BILLING; check the AWS console and the dashboard manually`,
        measurements: { remove_status: remove.status },
      });
    }

    return results;
  },
};
export default mod;
