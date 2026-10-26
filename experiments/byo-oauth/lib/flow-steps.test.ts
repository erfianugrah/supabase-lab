import { describe, expect, test } from "bun:test";
import { errorSummary, failedStep, stepMeasurements, type FlowStep } from "./flow-steps";

describe("errorSummary", () => {
  test("reduces a GoTrue JSON error to code, error_code and msg", () => {
    const body = '{"code":404,"error_code":"feature_disabled","msg":"OAuth server is disabled"}';
    expect(errorSummary(body)).toBe("feature_disabled: OAuth server is disabled");
  });

  test("falls back to message/error fields and to a cut of non-JSON text", () => {
    expect(errorSummary('{"message":"no Route matched with those values"}')).toBe("no Route matched with those values");
    expect(errorSummary('{"error":"invalid_request","error_description":"bad"}')).toBe("invalid_request: bad");
    expect(errorSummary("x".repeat(300))).toHaveLength(160);
  });

  test("never echoes a code or an authorization id from a redirect body", () => {
    const s = errorSummary('<a href="http://localhost:54321/callback?code=abc-123&state=s">Found</a>');
    expect(s).not.toContain("abc-123");
    const a = errorSummary('<a href="/oauth/consent?authorization_id=q2x7k">Found</a>');
    expect(a).not.toContain("q2x7k");
  });
});

describe("failedStep / stepMeasurements", () => {
  const steps: FlowStep[] = [
    { step: "register", status: 201, ok: true },
    { step: "authorize", status: 404, ok: false, error: "feature_disabled: OAuth server is disabled" },
  ];

  test("names the first failing step with its own status, not a later step's slot", () => {
    expect(failedStep(steps)).toBe("authorize HTTP 404 (feature_disabled: OAuth server is disabled)");
  });

  test("every step gets its own column; steps never reached read 0", () => {
    expect(stepMeasurements(steps)).toEqual({
      register_status: 201,
      authorize_status: 404,
      authorization_status: 0,
      consent_status: 0,
      token_status: 0,
    });
  });

  test("a fully green flow has no failed step", () => {
    const ok: FlowStep[] = ["register", "authorize", "authorization", "consent", "token"].map((s) => ({
      step: s as FlowStep["step"],
      status: 200,
      ok: true,
    }));
    expect(failedStep(ok)).toBeUndefined();
  });

  test("a step that answered 2xx but lacked what the next step needs still counts as the failure", () => {
    const s: FlowStep[] = [
      { step: "register", status: 201, ok: true },
      { step: "authorize", status: 302, ok: false, error: "no authorization_id in body" },
    ];
    expect(failedStep(s)).toBe("authorize HTTP 302 (no authorization_id in body)");
  });
});
