/**
 * Per-step record of O03's headless OAuth 2.1 code flow. Until 2026-10-26 the
 * module returned whichever earlier status it had in a field named
 * `consentStatus` (the client registration's status when registration
 * failed, the authorize call's when no authorization_id came back), so the
 * 2026-10-13 `consent=404` could have come from any of three calls. Each
 * step now has its own column and the first failure names its step.
 */

export type StepName = "register" | "authorize" | "authorization" | "consent" | "token";
export const STEPS: StepName[] = ["register", "authorize", "authorization", "consent", "token"];

export interface FlowStep {
  step: StepName;
  status: number;
  /** false when the call answered but did not yield what the next step needs */
  ok: boolean;
  error?: string;
}

/** GoTrue error JSON -> "error_code: msg"; anything else -> a 160-char cut with codes and ids masked. */
export function errorSummary(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const code = j.error_code ?? j.error;
    const msg = j.msg ?? j.message ?? j.error_description;
    if (code !== undefined || msg !== undefined) {
      return [code, msg].filter((v) => v !== undefined && v !== "").map(String).join(": ");
    }
  } catch {
    /* not JSON */
  }
  return text
    .replace(/([?&](?:code|authorization_id|state)=)[^&"'\s<]+/g, "$1<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

export function failedStep(steps: FlowStep[]): string | undefined {
  const f = steps.find((s) => !s.ok);
  if (!f) return undefined;
  return `${f.step} HTTP ${f.status}${f.error ? ` (${f.error})` : ""}`;
}

export function stepMeasurements(steps: FlowStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of STEPS) out[`${name}_status`] = steps.find((s) => s.step === name)?.status ?? 0;
  return out;
}
