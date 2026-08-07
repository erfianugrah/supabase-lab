/**
 * T15 - the customer-shaped client: Lambda in private subnets reaching the
 * endpoint on both ports. Invoked from the orchestrator, not the runner.
 */
import type { TestModule, TestResult } from "../../../harness/src/types";
import { invokeProbe } from "../lib/lambda-probe";

const mod: TestModule = {
  id: "T15",
  title: "Lambda in private subnets through the endpoint",
  where: "local",
  requires: ["lambda"],
  async run(ctx) {
    const res = await invokeProbe(ctx.region);
    if (!res.results?.length) {
      return {
        id: "T15",
        title: "Lambda through the endpoint",
        status: "fail",
        detail: "probe returned no results",
        evidence: res.raw.slice(0, 300),
      };
    }
    return res.results.map<TestResult>((r) => ({
      id: `T15-${r.port}`,
      title: `Lambda -> endpoint :${r.port}`,
      status: r.ok ? "pass" : "fail",
      detail: r.ok ? "connected from a VPC-attached Lambda" : (r.error ?? "failed"),
      measurements: {
        port: r.port,
        connect_ms: r.connect_ms ?? "",
        query_ms: r.query_ms ?? "",
        prepared_stmt: r.prepared ?? "",
      },
    }));
  },
};
export default mod;
