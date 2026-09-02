import { describe, expect, test } from "bun:test";
import { secretLimitOf, triage } from "./triage";

describe("triage order: error string, then parallelism, then landing", () => {
  test("the named size error is a deterministic size limit whose next question is the bundling path", () => {
    const t = triage({ errorText: "Function source code exceeds the maximum deployment size", status: 400, parallel: 1 });
    expect(t.bucket).toBe("size-limit");
    expect(t.deterministic).toBe(true);
    expect(t.next).toMatch(/5 MB/);
    expect(t.next).toMatch(/20 MB/);
  });

  test("a serial 413 with no message is still a size rejection", () => {
    expect(triage({ status: 413, parallel: 1 }).bucket).toBe("size-limit");
  });

  test("a 413 under parallel deploys is flagged misleading, not size", () => {
    const t = triage({ status: 413, parallel: 8 });
    expect(t.bucket).toBe("misleading-413");
    expect(t.deterministic).toBe(false);
    expect(t.next).toMatch(/serially/);
  });

  test("even the named size text under parallel 413 gets the parallelism question first", () => {
    expect(triage({ status: 413, parallel: 8, errorText: "payload too large" }).bucket).toBe("misleading-413");
  });

  test("a cap of exactly 1000 names the Pro plan and the entitlement lever", () => {
    const t = triage({ errorText: "maximum number of functions reached", capReported: 1000 });
    expect(t.bucket).toBe("count-limit");
    expect(t.next).toMatch(/pro plan/);
    expect(t.next).toMatch(/function\.max_count/);
  });

  test("ThrottlerException is a throttle, not a quota, and is non-deterministic", () => {
    const t = triage({
      errorText: 'unexpected list functions status 429: {"message":"ThrottlerException: Too Many Requests"}',
      status: 429,
      parallel: 8,
    });
    expect(t.bucket).toBe("throttled");
    expect(t.deterministic).toBe(false);
    expect(t.next).toMatch(/landed/);
  });

  test("409 is its own bucket and is never merged with 429", () => {
    expect(triage({ status: 409 }).bucket).toBe("conflict");
    expect(triage({ status: 409 }).next).toMatch(/not 429/);
  });

  test("exit 0 with the function absent afterwards is silent loss", () => {
    const t = triage({ exitCode: 0, landed: false, parallel: 8 });
    expect(t.bucket).toBe("silent-loss");
    expect(t.next).toMatch(/GET \/functions\/\{slug\}/);
  });

  test("a 201 with the function absent afterwards is silent loss too - the status code is not the state", () => {
    expect(triage({ status: 201, landed: false }).bucket).toBe("silent-loss");
  });

  test("a deploy that landed with no error has nothing to triage", () => {
    expect(triage({ status: 201, landed: true }).bucket).toBe("unknown");
  });

  test("runtime ceilings are invocation-time, not deploy-time", () => {
    expect(triage({ errorText: "WORKER_LIMIT: memory limit exceeded", status: 546 }).bucket).toBe("runtime-ceiling");
    expect(triage({ errorText: "IDLE_TIMEOUT", status: 504 }).bucket).toBe("runtime-ceiling");
  });

  test("an unnamed intermittent failure is not a limit", () => {
    const t = triage({ errorText: "Function not found", status: 404, exitCode: 1, parallel: 4 });
    expect(t.bucket).toBe("not-a-limit");
    expect(t.next).toMatch(/parallel/);
  });
});

describe("the strings the platform actually returned on 2026-09-02", () => {
  test("API deploy over 5 MB: 413 'request entity too large' is a serial size limit", () => {
    const t = triage({ status: 413, errorText: "request entity too large", parallel: 1 });
    expect(t.bucket).toBe("size-limit");
  });

  test("CLI wrapping the same 413 is still a size limit", () => {
    const t = triage({
      exitCode: 1,
      errorText: 'unexpected create function status 413: {"message":"request entity too large"}',
      parallel: 1,
    });
    expect(t.bucket).toBe("size-limit");
  });

  test("the 101st secret: 'You can only store 100 secrets per project at maximum.' is the count limit", () => {
    const t = triage({ status: 400, errorText: "You can only store 100 secrets per project at maximum." });
    expect(t.bucket).toBe("secret-limit");
    expect(t.secretLimit).toBe("count");
  });

  test("zod-style name/value refusals classify by field", () => {
    expect(secretLimitOf("0.name: Too big: expected string to have <=256 characters")).toBe("name-length");
    expect(secretLimitOf("0.value: Too big: expected string to have <=24576 characters")).toBe("value-size");
  });

  test("546 WORKER_RESOURCE_LIMIT is a runtime ceiling, not a deploy problem", () => {
    const t = triage({
      status: 546,
      errorText: '{"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not having enough compute resources (please check logs)"}',
    });
    expect(t.bucket).toBe("runtime-ceiling");
  });

  test("24 deploys all 201 with 14 absent afterwards is silent loss on every absent one", () => {
    expect(triage({ status: 201, landed: false, parallel: 8 }).bucket).toBe("silent-loss");
  });
});

describe("which of the four secrets limits", () => {
  test("reserved prefix", () => {
    expect(secretLimitOf("Secret name must not start with the SUPABASE_ prefix.")).toBe("reserved-prefix");
    expect(triage({ errorText: "Secret name must not start with the SUPABASE_ prefix.", status: 400 }).secretLimit).toBe("reserved-prefix");
  });
  test("name length", () => {
    expect(secretLimitOf("name must be shorter than or equal to 256 characters")).toBe("name-length");
  });
  test("value size", () => {
    expect(secretLimitOf("value must be shorter than or equal to 24576 characters")).toBe("value-size");
  });
  test("count, whose next step is an architecture conversation", () => {
    const t = triage({ errorText: "must contain no more than 100 secrets (maxItems)", status: 400 });
    expect(t.secretLimit).toBe("count");
    expect(t.next).toMatch(/architecture/);
  });
  test("no secret words, no secret limit", () => {
    expect(secretLimitOf("Function not found")).toBeUndefined();
  });
});
