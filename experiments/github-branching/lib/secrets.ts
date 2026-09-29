/**
 * Helpers for GB07 (preview-branch secrets), kept out of the module so the
 * classification that decides every reading is unit-tested.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt } from "../../../harness/src/mgmt.js";

export const N = {
  parent: "PVLAB_GB07_PARENT",
  dotenv: "PVLAB_GB07_DOTENV",
  wrongkey: "PVLAB_GB07_WRONGKEY",
  unset: "PVLAB_GB07_UNSET",
  key: "DOTENV_PRIVATE_KEY_PREVIEW",
} as const;
export const PROBED = Object.values(N);

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const throwaway = () => `gb07-${randomBytes(12).toString("hex")}`;

/** The function never returns a value: a class, a length, and a digest when present. */
export const PROBE_FN = `const NAMES = ${JSON.stringify(PROBED)};
async function digest(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
Deno.serve(async () => {
  const out = {};
  for (const n of NAMES) {
    const v = Deno.env.get(n);
    const cls = v === undefined ? "absent" : v === "" ? "empty" : v.startsWith("env(") ? "literal-env" : v.startsWith("encrypted:") ? "encrypted-literal" : "value";
    out[n] = { cls, len: v?.length ?? 0, sha256: v ? await digest(v) : "" };
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
});
`;

/**
 * One dotenvx keypair and a `.env.preview` holding `name=value`, generated in
 * a temp dir that is removed before returning. --no-native etc.: dotenvx 2.x
 * otherwise tries the OS keyring and fails without writing `.env.keys`.
 */
export function dotenvxFile(name: string, value: string): { envPreview: string; privateKey: string } {
  const d = mkdtempSync(join(tmpdir(), "gb07-"));
  try {
    const p = Bun.spawnSync(
      ["bunx", "--bun", "@dotenvx/dotenvx", "set", name, value, "-f", ".env.preview", "--no-native", "--no-1password", "--no-bitwarden"],
      { cwd: d },
    );
    if (p.exitCode !== 0) throw new Error(`dotenvx set exited ${p.exitCode}`);
    const envPreview = readFileSync(join(d, ".env.preview"), "utf8");
    const keys = readFileSync(join(d, ".env.keys"), "utf8");
    const privateKey = /^DOTENV_PRIVATE_KEY_PREVIEW="?([^"\n]+)"?/m.exec(keys)?.[1] ?? "";
    if (!privateKey) throw new Error("dotenvx wrote no DOTENV_PRIVATE_KEY_PREVIEW");
    if (!envPreview.includes(`${name}="encrypted:`)) throw new Error("dotenvx did not encrypt the value");
    return { envPreview, privateKey };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** How a listed `value` relates to what the module set: never the value itself. */
export function listedClass(listed: string | undefined, expected: string | undefined): string {
  if (listed === undefined) return "absent";
  if (expected === undefined) return listed === sha256("") ? "sha256-of-empty" : "listed";
  if (listed === sha256(expected)) return "sha256";
  if (listed === expected) return "plaintext";
  if (listed === sha256("")) return "sha256-of-empty";
  return "other";
}

export async function listSecrets(ctx: Ctx, ref: string): Promise<Map<string, string>> {
  const r = await mgmt(ctx, "GET", `/projects/${ref}/secrets`);
  const rows = Array.isArray(r.json) ? (r.json as { name?: string; value?: string }[]) : [];
  return new Map(rows.map((s) => [String(s.name ?? ""), String(s.value ?? "")]));
}

/**
 * Terminal when a run exists and either a step died (GB03: `migrate:DEAD`
 * leaves the later steps at CREATED for good) or none is still waiting or
 * running.
 */
export function terminal(steps: string): boolean {
  if (!steps) return false;
  if (/:DEAD\b/i.test(steps)) return true;
  return !/:(CREATED|RUNNING|RESTARTING|PAUSED)\b/i.test(steps);
}

