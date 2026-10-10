import { describe, expect, test } from "bun:test";
import { counts, type TofuRun } from "./tofu";

const run = (stdout: string, stderr = ""): TofuRun => ({ exitCode: 0, stdout, stderr, ms: 1 });

describe("counts", () => {
  test("apply summary and per-resource completions", () => {
    const c = counts(
      run(
        [
          'supabase_edge_function.fn["a"]: Creation complete after 1s [id=x]',
          'supabase_edge_function.fn["b"]: Creation complete after 1s [id=y]',
          "Apply complete! Resources: 2 added, 0 changed, 0 destroyed.",
        ].join("\n"),
      ),
    );
    expect(c.created).toBe(2);
    expect(c.errors).toBe(0);
    expect(c.summary).toBe("Apply complete! Resources: 2 added, 0 changed, 0 destroyed.");
  });

  test("plan line", () => {
    expect(counts(run("Plan: 19 to add, 1 to change, 0 to destroy.")).planned).toEqual({ add: 19, change: 1, destroy: 0 });
    expect(counts(run("No changes.")).planned).toBeNull();
  });

  test("inconsistent-result errors are grouped by attribute", () => {
    const block = (attr: string) =>
      `Error: Provider produced inconsistent result after apply\n\nWhen applying changes to x, provider "p" produced an\nunexpected new value: ${attr}: was 1, but now 2.\n\nThis is a bug in the provider.\n`;
    const c = counts(run([block(".updated_at"), block(".version"), block(".version")].join("\n")));
    expect(c.errors).toBe(3);
    expect(c.inconsistentAttrs).toBe(".updated_at:1|.version:2");
    expect(c.errorSample.startsWith("Error: Provider produced inconsistent result after apply")).toBe(true);
    expect(c.errorSample).not.toContain("Error: Provider produced inconsistent result after apply Error:");
  });
});
