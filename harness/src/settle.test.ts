import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDrainWatch, settleModule } from "./settle";
import type { RunArtifact } from "./types";

/** A drain watch driven by hand instead of by process "beforeExit". */
function manualWatch() {
  let fire: () => void = () => {};
  const watch = createDrainWatch((cb) => {
    fire = cb;
  });
  return { watch, drain: () => fire() };
}

describe("settleModule", () => {
  test("a settled module returns its value and disarms the watch", async () => {
    const { watch } = manualWatch();
    const o = await settleModule(async () => 42, watch);
    expect(o).toEqual({ kind: "settled", value: 42 });
    expect(watch.armed()).toBe(false);
  });

  test("a throw, sync or async, is reported as threw", async () => {
    const { watch } = manualWatch();
    const a = await settleModule(async () => {
      throw new Error("boom");
    }, watch);
    expect(a.kind).toBe("threw");
    const b = await settleModule(() => {
      throw new Error("sync boom");
    }, watch);
    expect(b.kind).toBe("threw");
  });

  test("an event-loop drain while a module is pending ends it as drained", async () => {
    const { watch, drain } = manualWatch();
    const p = settleModule(() => new Promise<number>(() => {}), watch);
    expect(watch.armed()).toBe(true);
    drain();
    expect(await p).toEqual({ kind: "drained" });
    expect(watch.armed()).toBe(false);
  });

  test("a declared timeout ends a module that is still pending", async () => {
    const { watch } = manualWatch();
    const o = await settleModule(() => new Promise<number>(() => {}), watch, 20);
    expect(o).toEqual({ kind: "timeout", ms: 20 });
  });

  test("a drain with no module armed goes to the idle callback, not to a module", async () => {
    let fire: () => void = () => {};
    let idle = 0;
    const watch = createDrainWatch(
      (cb) => {
        fire = cb;
      },
      () => idle++,
    );
    fire();
    expect(idle).toBe(1);
    const p = settleModule(() => new Promise<number>(() => {}), watch);
    fire();
    expect(await p).toEqual({ kind: "drained" });
    expect(idle).toBe(1);
  });
});

/**
 * End to end: run.ts with a module whose promise never settles and nothing
 * pending (2026-10-23: `Bun.write(path, response)` hung on a download
 * and pvlab exited 0 with no result and no artifact). The runner source is
 * copied to a temp dir without tests.generated.ts, because run.ts prefers a
 * generated registry over `--tests` and a checkout that ran `bun run gen`
 * would never load the fixture.
 */
describe("run.ts with a module that never settles", () => {
  async function runFixture(modules: Record<string, string>, only: string) {
    const dir = await mkdtemp(join(tmpdir(), "pvlab-settle-"));
    try {
      const src = join(dir, "src");
      const tests = join(dir, "tests");
      const out = join(dir, "out");
      await Bun.$`mkdir -p ${src} ${tests}`.quiet();
      for (const f of await readdir(import.meta.dir)) {
        if (f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "tests.generated.ts") {
          await copyFile(join(import.meta.dir, f), join(src, f));
        }
      }
      for (const [name, body] of Object.entries(modules)) await writeFile(join(tests, name), body);
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PVLAB_ALLOW_SLEEP: "1" };
      const proc = Bun.spawn(
        ["bun", join(src, "run.ts"), "--where", "local", "--tests", tests, "--out", out, "--only", only],
        { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
      );
      // A regression hangs the child; kill it before bun test's own timeout so
      // the finally below still cleans up.
      const kill = setTimeout(() => proc.kill(), 20_000);
      const code = await proc.exited;
      clearTimeout(kill);
      const log = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
      const json = (await readdir(out).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
      const artifact = json[0] ? ((await Bun.file(join(out, json[0])).json()) as RunArtifact) : undefined;
      return { code, log, artifact };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const hung = `export default {
  id: "W01", title: "never settles", where: "local",
  async run() { await new Promise(() => {}); return { id: "W01", title: "never settles", status: "pass" }; },
};`;
  const after = `export default {
  id: "W02", title: "runs after the hang", where: "local",
  async run() { return { id: "W02", title: "runs after the hang", status: "pass" }; },
};`;
  const slow = `export default {
  id: "W03", title: "pending timer past its timeout", where: "local", timeoutMs: 200,
  async run() { await new Promise((r) => setTimeout(r, 60_000)); return { id: "W03", title: "t", status: "pass" }; },
};`;

  test("records a failed result, writes the artifact, keeps going and exits non-zero", async () => {
    const { code, log, artifact } = await runFixture({ "w01.ts": hung, "w02.ts": after }, "W01,W02");
    expect(artifact, log).toBeDefined();
    const w01 = artifact!.results.find((r) => r.id === "W01");
    expect(w01?.status).toBe("fail");
    expect(w01?.detail).toContain("never settled");
    expect(artifact!.results.find((r) => r.id === "W02")?.status).toBe("pass");
    expect(code, log).toBe(2);
  }, 30_000);

  test("a drain outside any module (the artifact write never settles) exits 1, not 0", async () => {
    // The module returns normally but swaps Bun.write for a never-settling
    // stub, so the runner hangs in its own artifact write after the loop.
    const breaksWrite = `export default {
  id: "W04", title: "breaks the artifact write", where: "local",
  async run() { Bun.write = () => new Promise(() => {}); return { id: "W04", title: "t", status: "pass" }; },
};`;
    const { code, log, artifact } = await runFixture({ "w04.ts": breaksWrite }, "W04");
    expect(artifact).toBeUndefined();
    expect(log).toContain("outside any module");
    expect(code, log).toBe(1);
  }, 30_000);

  test("a module past its declared timeoutMs is failed even while it holds a pending handle", async () => {
    const t0 = performance.now();
    const { code, log, artifact } = await runFixture({ "w03.ts": slow }, "W03");
    expect(performance.now() - t0).toBeLessThan(20_000);
    const w03 = artifact?.results.find((r) => r.id === "W03");
    expect(w03?.status, log).toBe("fail");
    expect(w03?.detail).toContain("timeoutMs");
    expect(code, log).toBe(2);
  }, 30_000);
});
