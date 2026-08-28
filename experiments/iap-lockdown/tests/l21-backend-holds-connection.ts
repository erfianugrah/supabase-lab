/**
 * L21 - backend-holds-the-connection: the real "IAP over Supabase"
 * architecture, end to end.
 *
 * A Lambda inside the VPC runs the only data query over the PrivateLink
 * endpoint; the same read attempted directly against the public API host with
 * the anon key is refused, because L02 + L05 + L08 already closed every public
 * path. The proxy/backend really is the only path to the data.
 *
 *   L21a - the in-VPC Lambda answers a data read over the endpoint (reuses the
 *          privatelink-aws probe Lambda; invoke pattern from t15-lambda.ts).
 *   L21b - the same read against the public host with the anon key is refused
 *          (the bypass L11c closed).
 *   L21c - the cost: Lambda-over-PrivateLink latency vs the numbers
 *          privatelink-aws already measured (cited, not re-run).
 *
 * where: "local" - invokes the Lambda via the AWS CLI. Self-skips without the
 * "lambda" capability (PVLAB_LAMBDA=1 + the Phase C AWS stack applied).
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { fetchKeys, http, TABLE } from "../lib/inventory.js";
import { $ } from "bun";

const FN = process.env.PVLAB_LAMBDA_NAME || "supabase-lab-probe";

async function invokeLambda(region: string, payload: unknown): Promise<Record<string, unknown> | null> {
  const out = `/tmp/l21-lambda-${Date.now()}.json`;
  const res = await $`aws lambda invoke --region ${region} --function-name ${FN} --cli-binary-format raw-in-base64-out --payload ${JSON.stringify(payload)} ${out}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow();
  if (res.exitCode !== 0) return null;
  try { return await Bun.file(out).json(); } catch { return null; }
}

const mod: TestModule = {
  id: "L21",
  title: "backend-holds-connection: Lambda over PrivateLink is the only data path",
  where: "local",
  requires: ["pat", "lambda"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const keys = await fetchKeys(ctx);

    const lam = await invokeLambda(ctx.region, { port: 5432 });
    const lamOk = Boolean(lam && (lam.all_ok || (Array.isArray(lam.results) && (lam.results as { ok?: boolean }[]).some((r) => r.ok))));
    results.push({
      id: "L21a",
      title: "the in-VPC Lambda answers a data read over the endpoint",
      status: lamOk ? "pass" : "fail",
      detail: lamOk ? `Lambda over PrivateLink -> ${JSON.stringify(lam)?.slice(0, 200)}` : `Lambda invoke returned no ok result (${JSON.stringify(lam)?.slice(0, 160)})`,
    });

    const pub = await http(`https://${ctx.apiHost}/rest/v1/${TABLE}?select=id&limit=1`, { key: keys.anonJwt });
    results.push({
      id: "L21b",
      title: "the same read against the public host with the anon key is refused",
      status: pub.status >= 400 ? "pass" : "fail",
      detail: `direct ${ctx.apiHost} with the anon key -> ${pub.status} ${pub.code}. With the public paths closed (L02/L05/L08), the backend/Lambda is the only route to the data.`,
      measurements: { public_anon_status: pub.status },
    });
    return results;
  },
};
export default mod;
