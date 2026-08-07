/**
 * T21 - what happens to clients when one AZ's endpoint ENI is unreachable.
 *
 * The endpoint puts one ENI per private subnet and the PHZ A record carries
 * both, so the question is whether a client actually fails over. That is a
 * CLIENT-STACK property, not a platform one: libpq tries every address a
 * hostname resolves to, while Node's default resolution hands the driver a
 * single address. Both are measured here, because the customer's runtime is
 * node-postgres in Lambda but their tooling is psql.
 *
 * Method: blackhole ONE ENI address with a NACL rule (security groups cannot
 * express deny), then probe from INSIDE the VPC - via the Lambda for node-pg
 * and via SSM psql for libpq. Reverted afterwards.
 *
 * The first version of this test ran the probes from the orchestrator, which
 * cannot reach a private endpoint at all: its baseline failed and it still
 * reported "clients do not fail over". A test whose control is broken must
 * report nothing, so the baseline gate below is load-bearing.
 *
 * DESTRUCTIVE: mutates a network ACL for the duration.
 */
import { $ } from "bun";
import type { Ctx, TestModule } from "../../../harness/src/types";
import { invokeProbe } from "../lib/lambda-probe";

const RULE = 99;

async function aws(args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = await $`aws ${args}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow();
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}

/** psql from the runner: libpq, which tries every resolved address. */
async function psqlViaRunner(ctx: Ctx, runnerId: string): Promise<boolean | null> {
  const cmd = `PGPASSWORD='${ctx.dbPassword}' PGCONNECT_TIMEOUT=20 psql "host=${ctx.phzHost} port=5432 user=postgres dbname=postgres sslmode=require" -tAc 'select 1'`;
  const send = await aws([
    "ssm", "send-command", "--region", ctx.region, "--instance-ids", runnerId,
    "--document-name", "AWS-RunShellScript", "--timeout-seconds", "120",
    "--parameters", JSON.stringify({ commands: [cmd] }),
    "--query", "Command.CommandId", "--output", "text",
  ]);
  if (!send.ok) return null;
  const cid = send.out.trim();
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(5000);
    const inv = await aws([
      "ssm", "get-command-invocation", "--region", ctx.region,
      "--command-id", cid, "--instance-id", runnerId,
      "--query", "{s:Status,o:StandardOutputContent}", "--output", "json",
    ]);
    if (!inv.ok) continue;
    const { s, o } = JSON.parse(inv.out) as { s: string; o: string };
    if (["Success", "Failed", "TimedOut", "Cancelled"].includes(s)) return o.trim() === "1";
  }
  return null;
}

const mod: TestModule = {
  id: "T21",
  title: "Client failover when one endpoint ENI is unreachable",
  where: "local",
  requires: ["db", "endpoint", "lambda"],
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

    const runner = await aws([
      "ec2", "describe-instances", "--region", ctx.region,
      "--filters", "Name=tag:Name,Values=supabase-lab-runner", "Name=instance-state-name,Values=running",
      "--query", "Reservations[0].Instances[0].InstanceId", "--output", "text",
    ]);
    const runnerId = runner.ok ? runner.out.trim() : "";

    // BASELINE GATE: if the in-VPC probes do not work before the blackhole,
    // anything measured after it is meaningless.
    const baseLambda = (await invokeProbe(ctx.region, { port: 5432 })).all_ok === true;
    const basePsql = runnerId ? await psqlViaRunner(ctx, runnerId) : null;
    if (!baseLambda) {
      return {
        id: "T21",
        title: mod.title,
        status: "skip",
        detail: "baseline Lambda probe failed - no working control, so no conclusion is possible",
      };
    }

    const nacl = await aws([
      "ec2", "describe-network-acls", "--region", ctx.region,
      "--filters", "Name=default,Values=true", `Name=vpc-id,Values=${await labVpc(ctx)}`,
      "--query", "NetworkAcls[0].NetworkAclId", "--output", "text",
    ]);
    if (!nacl.ok || !nacl.out.trim() || nacl.out.includes("None")) {
      return { id: "T21", title: mod.title, status: "skip", detail: "could not find the lab VPC NACL" };
    }
    const naclId = nacl.out.trim();

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
        detail: `could not install the blackhole: ${add.out.slice(0, 140)}`,
      };
    }

    try {
      await Bun.sleep(8000);
      let lambdaOk = 0;
      for (let i = 0; i < 3; i++) {
        if ((await invokeProbe(ctx.region, { port: 5432 })).all_ok === true) lambdaOk++;
      }
      const psqlOk = runnerId ? await psqlViaRunner(ctx, runnerId) : null;

      return {
        id: "T21",
        title: mod.title,
        status: "info",
        detail:
          `one ENI (${target}) blackholed: node-postgres ${lambdaOk}/3 succeeded, ` +
          `psql/libpq ${psqlOk === null ? "not measured" : psqlOk ? "succeeded" : "failed"}` +
          (lambdaOk < 3 && psqlOk
            ? " - libpq fails over across the PHZ's two A records, the Node driver does not"
            : ""),
        measurements: {
          blackholed_ip: target,
          baseline_lambda: baseLambda ? "ok" : "failed",
          baseline_psql: basePsql === null ? "not measured" : basePsql ? "ok" : "failed",
          node_pg_successes: `${lambdaOk}/3`,
          libpq_success: psqlOk === null ? "not measured" : psqlOk ? "yes" : "no",
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

async function labVpc(ctx: Ctx): Promise<string> {
  const r = await aws([
    "ec2", "describe-vpcs", "--region", ctx.region,
    "--filters", "Name=tag:Name,Values=supabase-lab",
    "--query", "Vpcs[0].VpcId", "--output", "text",
  ]);
  return r.ok ? r.out.trim() : "";
}

export default mod;
