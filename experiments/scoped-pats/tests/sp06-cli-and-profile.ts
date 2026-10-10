/**
 * SP06 - what a token does to `GET /v1/profile` and to the Supabase CLI.
 *
 * Doc claim (changelog scoped-personal-access-tokens-ga, 2026-10-06): the
 * token activates with `SUPABASE_ACCESS_TOKEN` or `supabase login --token`,
 * and `supabase whoami` does not work with a project- or organization-scoped
 * token. Earlier staging evidence (s2z-wake RUNLOG): an org-scoped token gets
 * `403 "This endpoint requires a user-scoped access token"` on /profile.
 *
 * Per token (the lab token always, scoped tokens when supplied):
 *   - `GET /v1/profile` status and refusal text,
 *   - `supabase whoami`, `supabase orgs list`, `supabase projects list`: exit
 *     code and line count of stdout, with the token passed only through the
 *     child's environment and HOME pointed at an empty temp dir so the CLI
 *     stores nothing in the real profile. A success prints account data, so
 *     stdout is counted, never stored; a failure stores a scrubbed stderr.
 *
 * The CLI is the vendor's published binary and the commands are read-only.
 * Skips the CLI half when `supabase` is not on PATH.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { call, scrub } from "../lib/http.js";
import { ROLES, skipReason, tokenFor } from "../lib/tokens.js";

async function cli(token: string, args: string[], home: string): Promise<{ code: number; lines: number; err: string; version?: string }> {
  const p = Bun.spawn(["supabase", ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, SUPABASE_ACCESS_TOKEN: token, NO_COLOR: "1", SUPABASE_TELEMETRY_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), 60_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, lines: out.split("\n").filter(Boolean).length, err: scrub(err.replace(/\s+/g, " ").trim(), 200) };
}

const mod: TestModule = {
  id: "SP06",
  title: "Profile endpoint and CLI whoami / orgs list / projects list per token",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx): Promise<TestResult[]> {
    const tokens: Array<{ name: string; token: string }> = [{ name: "lab", token: ctx.pat ?? "" }];
    const results: TestResult[] = [];
    for (const r of ROLES.filter((x) => ["legacy", "org", "ro", "narrow"].includes(x.role))) {
      if (tokenFor(r)) tokens.push({ name: r.role, token: tokenFor(r) });
      else results.push({ id: `SP06-${r.role}`, title: `SP06-${r.role}`, status: "skip", detail: skipReason(r) });
    }
    const which = Bun.spawnSync(["which", "supabase"]);
    const haveCli = which.exitCode === 0;
    const home = await mkdtemp(join(tmpdir(), "sp06-"));
    try {
      const ver = haveCli
        ? new TextDecoder().decode(Bun.spawnSync(["supabase", "--version"], { env: { PATH: process.env.PATH ?? "", HOME: home } }).stdout).trim()
        : "n/a";
      for (const t of tokens) {
        const prof = await call(t.token, "GET", "/profile");
        const m: Record<string, number | string> = { profile_status: prof.status, cli_version: ver };
        let ev = `profile: ${prof.status === 200 ? "200 (body not stored)" : scrub(prof.text)}`;
        if (haveCli) {
          for (const sub of [["whoami"], ["orgs", "list"], ["projects", "list"]]) {
            const k = sub.join("_");
            const r = await cli(t.token, sub, home);
            m[`${k}_exit`] = r.code;
            m[`${k}_stdout_lines`] = r.lines;
            if (r.code !== 0) ev += `\n${sub.join(" ")}: ${r.err}`;
          }
        }
        results.push({
          id: `SP06-${t.name}`,
          title: `SP06-${t.name}: /profile and CLI reads`,
          status: "info",
          detail: haveCli ? undefined : "supabase CLI not on PATH; CLI half not run",
          measurements: m,
          evidence: ev,
        });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    return results;
  },
};
export default mod;
