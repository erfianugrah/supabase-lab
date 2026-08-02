/**
 * T21 - what happens to clients when one AZ's endpoint ENI is unreachable.
 *
 * The endpoint places one ENI per private subnet and the PHZ A record carries
 * both addresses, so the question is whether a client actually fails over or
 * just fails. libpq tries the addresses a hostname resolves to in order, so
 * the answer depends on connect timeouts, not on anything Supabase controls -
 * which is exactly why it is worth measuring rather than assuming.
 *
 * Method: a NACL rule on the runner's subnet blackholes ONE ENI address
 * (security groups cannot express deny). Then connect via the PHZ name
 * repeatedly and count successes. Reverted at the end.
 *
 * DESTRUCTIVE: mutates a network ACL for the duration.
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";

const RULE = 99;

async function aws(args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = await $`aws ${args}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow();
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}

async function connectVia(ctx: Ctx, timeoutMs: number): Promise<number | null> {
  const c = new Client({
    host: ctx.phzHost,
    port: 5432,
    user: "postgres",
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: timeoutMs,
  });
  const t0 = performance.now();
  try {
    await c.connect();
    await c.query("select 1");
    return Math.round(performance.now() - t0);
  } catch {
    return null;
  } finally {
    await c.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "T21",
  title: "Client behaviour when one endpoint ENI is unreachable",
  where: "local",
  requires: ["db", "endpoint"],
  destructive: true,
  async run(ctx) {
    const target = ctx.endpointIps[0];
    if (!target || ctx.endpointIps.length < 2) {
      return {
        id: "T21",
        title: mod.title,
        status: "skip",
        detail: `need two endpoint ENIs, have ${ctx.endpointIps.length}`,
      };
    }

    // The runner's subnets share a NACL; find it via the endpoint's VPC.
    const nacl = await aws([
      "ec2", "describe-network-acls", "--region", ctx.region,
      "--filters", "Name=default,Values=true",
      "--query", "NetworkAcls[0].NetworkAclId", "--output", "text",
    ]);
    if (!nacl.ok) {
      return { id: "T21", title: mod.title, status: "skip", detail: "could not find the VPC NACL" };
    }
    const naclId = nacl.out.trim();

    const before = await connectVia(ctx, 8000);
    const add = await aws([
      "ec2", "create-network-acl-entry", "--region", ctx.region,
      "--network-acl-id", naclId, "--rule-number", String(RULE),
      "--protocol", "-1", "--rule-action", "deny", "--egress",
      "--cidr-block", `${target}/32`,
    ]);
    if (!add.ok) {
      return {
        id: "T21",
        title: mod.title,
        status: "skip",
        detail: `could not install the blackhole rule: ${add.out.slice(0, 140)}`,
      };
    }

    try {
      await Bun.sleep(5000); // let the NACL change take effect
      const samples: Array<number | null> = [];
      for (let i = 0; i < 5; i++) samples.push(await connectVia(ctx, 15000));
      const ok = samples.filter((s) => s !== null) as number[];
      const worst = ok.length ? Math.max(...ok) : 0;

      return {
        id: "T21",
        title: mod.title,
        status: ok.length === samples.length ? "pass" : ok.length ? "info" : "fail",
        detail:
          ok.length === samples.length
            ? `client failed over to the surviving ENI on every attempt (worst connect ${worst}ms vs ${before}ms baseline)`
            : ok.length
              ? `partial: ${ok.length}/${samples.length} connects succeeded - failover is not reliable within the timeout`
              : "no connection succeeded with one ENI blackholed - clients do NOT fail over",
        measurements: {
          blackholed_ip: target,
          baseline_ms: before ?? "failed",
          successes: `${ok.length}/${samples.length}`,
          worst_connect_ms: worst,
        },
      };
    } finally {
      await aws([
        "ec2", "delete-network-acl-entry", "--region", ctx.region,
        "--network-acl-id", naclId, "--rule-number", String(RULE), "--egress",
      ]);
    }
  },
};
export default mod;
