/**
 * T19 - what removing the AWS account association does to live clients.
 *
 * Cannot be automated end to end: the /platform routes reject PATs, so the
 * removal itself is a dashboard action. The test does the measurable half -
 * watch the RAM share and the client path together, so the ORDER and the
 * client-visible effect are recorded rather than assumed.
 *
 * Set PVLAB_EXPECT_MANUAL_DELETE=1 to arm it; otherwise it skips rather than
 * sitting in a polling loop nobody is watching.
 *
 * DESTRUCTIVE: the operator removes the association during the run.
 */
import { $ } from "bun";
import { Client } from "pg";
import type { Ctx, TestModule } from "../../../harness/src/types";

const MAX_WAIT_MS = 360_000;

async function shareStatus(ctx: Ctx): Promise<string> {
  const p = await $`aws ram get-resource-shares --resource-owner OTHER-ACCOUNTS --region ${ctx.region} --query ${`resourceShares[?contains(name, '${ctx.ref}')].status | [0]`} --output text`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow()
    .text();
  return p.trim() || "unknown";
}

async function dbOk(ctx: Ctx): Promise<boolean> {
  const c = new Client({
    host: ctx.phzHost,
    port: 5432,
    user: "postgres",
    database: "postgres",
    password: ctx.dbPassword,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 6000,
  });
  try {
    await c.connect();
    await c.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

const mod: TestModule = {
  id: "T19",
  title: "Association DELETE - client impact and ordering",
  where: "local",
  requires: ["db", "endpoint"],
  destructive: true,
  async run(ctx) {
    if (process.env.PVLAB_EXPECT_MANUAL_DELETE !== "1") {
      return {
        id: "T19",
        title: mod.title,
        status: "skip",
        detail:
          "needs a dashboard removal (the /platform API rejects PATs); set PVLAB_EXPECT_MANUAL_DELETE=1 and remove the AWS account when prompted",
      };
    }

    ctx.log(">>> Remove the AWS account in Settings > Integrations > AWS PrivateLink now <<<");
    const t0 = Date.now();
    let shareGoneAt: number | null = null;
    let clientBrokeAt: number | null = null;
    const timeline: string[] = [];

    while (Date.now() - t0 < MAX_WAIT_MS) {
      const [status, ok] = await Promise.all([shareStatus(ctx), dbOk(ctx)]);
      const t = Math.round((Date.now() - t0) / 1000);
      timeline.push(`${t}s share=${status} db_ok=${ok}`);
      ctx.log(`${t}s share=${status} db_ok=${ok}`);

      if (shareGoneAt === null && !/ACTIVE/i.test(status)) shareGoneAt = Date.now();
      if (clientBrokeAt === null && !ok) clientBrokeAt = Date.now();
      if (shareGoneAt !== null && clientBrokeAt !== null) break;
      await Bun.sleep(5000);
    }

    if (shareGoneAt === null && clientBrokeAt === null) {
      return {
        id: "T19",
        title: mod.title,
        status: "info",
        detail: "no removal observed within the window - association left in place",
        evidence: timeline.slice(-6).join("\n"),
      };
    }

    const order =
      shareGoneAt && clientBrokeAt
        ? shareGoneAt <= clientBrokeAt
          ? "RAM share revoked first, clients broke after"
          : "clients broke first, RAM share revoked after"
        : shareGoneAt
          ? "RAM share revoked; clients still connecting at the end of the window"
          : "clients broke; RAM share still ACTIVE";

    return {
      id: "T19",
      title: mod.title,
      status: "info",
      detail: order,
      measurements: {
        share_revoked_after_s: shareGoneAt ? Math.round((shareGoneAt - t0) / 1000) : "not observed",
        clients_broke_after_s: clientBrokeAt ? Math.round((clientBrokeAt - t0) / 1000) : "not observed",
      },
      evidence: timeline.join("\n"),
    };
  },
};
export default mod;
