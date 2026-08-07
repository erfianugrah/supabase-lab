/**
 * Invoke the pvlab probe Lambda and parse its JSON payload.
 *
 * Lives in lib/, not tests/: the registry statically imports every .ts file
 * under tests/ as a default-exported TestModule, so a helper file there
 * becomes an undefined registry entry. T15, T19, T21, and T24 all invoke the
 * same function shape - T15/T19/T21 against the primary probe Lambda in the
 * lab VPC, T24 against the second VPC's probe Lambda by name - so this moved
 * out of t15-lambda.ts rather than being duplicated per caller.
 */
import { $ } from "bun";

export interface ProbeResult {
  port: number;
  ok: boolean;
  connect_ms?: number;
  query_ms?: number;
  prepared?: string;
  error?: string;
}

export interface ProbeInvocation {
  all_ok?: boolean;
  results?: ProbeResult[];
  raw: string;
}

export async function invokeProbe(
  region: string,
  payload: Record<string, unknown> = {},
  functionName = "supabase-lab-probe",
): Promise<ProbeInvocation> {
  const out = `/tmp/pvlab-lambda-out-${functionName}.json`;
  await $`aws lambda invoke --region ${region} --function-name ${functionName} --cli-binary-format raw-in-base64-out --payload ${JSON.stringify(payload)} ${out}`
    .env({ ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })
    .quiet()
    .nothrow();
  const raw = await Bun.file(out)
    .text()
    .catch(() => "");
  try {
    return { ...(JSON.parse(raw) as Omit<ProbeInvocation, "raw">), raw };
  } catch {
    return { raw };
  }
}
