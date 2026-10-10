/**
 * Run state shared by HP01..HP09: which throwaway project this run created and
 * which custom hostname it put on it. The modules run in one process in id
 * order, but a crashed run has to be tear-down-able by a later `make down`,
 * so the state lives in a gitignored file next to the experiment, not in
 * memory. It carries the project ref, so it is never committed.
 */
import type { Ctx } from "../../../harness/src/types";

export const STATE_PATH = `${import.meta.dir}/../.state.json`;
export const PREFIX = "hp-";

export interface HpState {
  ref: string;
  name: string;
  /** Custom hostname chosen for this run (set by HP01, activated by HP03). */
  host: string;
  createdAt: string;
  /** Anon JWT for the project (public by design). */
  anon: string;
  domainActive: boolean;
  /** DNS names this run wrote into the Cloudflare zone (for teardown). */
  dnsNames: string[];
  idpUrl: string;
}

export async function loadState(): Promise<HpState | undefined> {
  const f = Bun.file(STATE_PATH);
  if (!(await f.exists())) return undefined;
  return JSON.parse(await f.text()) as HpState;
}

export async function saveState(s: HpState): Promise<void> {
  await Bun.write(STATE_PATH, JSON.stringify(s, null, 2));
}

/** Point ctx at the project HP01 created. Returns undefined when there is none. */
export async function useState(ctx: Ctx): Promise<HpState | undefined> {
  const s = await loadState();
  if (!s) return undefined;
  ctx.ref = s.ref;
  ctx.apiHost = `${s.ref}.supabase.co`;
  return s;
}

/** Decode a JWT payload without verifying it (the claims are what is measured). */
export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The confirmed password user HP01 creates, for sign-in probes. */
export const PW = "Hp-pass-2026-xyz!";
export const USER_EMAIL = "hp-user@lab.test";

/** Replace the project ref and custom host in free text so evidence strings stay publishable. */
export function scrub(text: string, ref: string, host?: string): string {
  let t = text.split(ref).join("<ref>");
  if (host) t = t.split(host).join("<custom-host>");
  return t;
}
