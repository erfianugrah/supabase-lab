/**
 * `custom-hostname/activate` with a retry. On 2026-10-06 the call answered 400
 * straight after reverify reported 4_origin_setup_completed and 201 when made
 * by hand about ten minutes later; the cause is open, so HS04 retries and
 * records the first refusal's body rather than failing on it. The API call and
 * the sleep are injected so the retry branch is unit-tested (activate.test.ts):
 * the live re-run got 201 first time and never exercised it.
 */
export interface ActivateOutcome {
  /** "HTTP <status>", plus the body (300 characters) when the first call was refused. */
  first: string;
  attempts: number;
  lastStatus: number;
}

export async function activateWithRetry(
  call: () => Promise<{ status: number; text: string }>,
  sleep: (ms: number) => Promise<void>,
  opts: { retries?: number; waitMs?: number } = {},
): Promise<ActivateOutcome> {
  const retries = opts.retries ?? 15;
  const waitMs = opts.waitMs ?? 40_000;
  let r = await call();
  const first = `HTTP ${r.status}${r.status >= 300 ? ` ${r.text.slice(0, 300)}` : ""}`;
  let attempts = 1;
  while (r.status >= 300 && attempts <= retries) {
    await sleep(waitMs);
    r = await call();
    attempts++;
  }
  return { first, attempts, lastStatus: r.status };
}
