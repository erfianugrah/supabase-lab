/**
 * Shared helpers for the free-email-templates modules: throwaway project
 * lifecycle, a retrying Management API call, and redacted views of the auth
 * config so evidence never carries a secret.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmt, type MgmtResponse } from "../../../harness/src/mgmt.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const REGION = "ap-southeast-1";

/** Template kinds under test (Management API field-name stems). */
export const TEMPLATE_KINDS = [
  "confirmation",
  "invite",
  "magic_link",
  "recovery",
  "email_change",
  "reauthentication",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const contentField = (k: TemplateKind) => `mailer_templates_${k}_content`;
export const subjectField = (k: TemplateKind) => `mailer_subjects_${k}`;

/** mgmt() with backoff on throttle (HTML interstitial) and 429. */
export async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<MgmtResponse> {
  let last: MgmtResponse | undefined;
  for (let i = 0; i < 6; i++) {
    last = await mgmt(ctx, method, path, body);
    if (last.status !== 429 && !last.throttled) return last;
    await sleep(15_000 * (i + 1));
  }
  return last as MgmtResponse;
}

export async function createProject(
  ctx: Ctx,
  org: string,
  name: string,
): Promise<{ res: MgmtResponse; ref: string }> {
  const res = await call(ctx, "POST", "/projects", {
    organization_slug: org,
    name,
    db_pass: `${crypto.randomUUID()}Aa1!`,
    region: REGION,
  });
  const ref = (res.json as { ref?: string } | undefined)?.ref ?? "";
  return { res, ref };
}

export async function waitHealthy(
  ctx: Ctx,
  ref: string,
  maxMs = 20 * 60_000,
): Promise<{ status: string; ms: number }> {
  const t0 = Date.now();
  let status = "";
  while (Date.now() - t0 < maxMs) {
    const p = await call(ctx, "GET", `/projects/${ref}`);
    status = String((p.json as { status?: string } | undefined)?.status ?? "");
    if (status === "ACTIVE_HEALTHY") break;
    await sleep(10_000);
  }
  return { status, ms: Date.now() - t0 };
}

/** The auth-config endpoint can lag the project status; poll for a 200. */
export async function waitAuthConfig(
  ctx: Ctx,
  ref: string,
  maxMs = 5 * 60_000,
): Promise<{ status: number; ms: number }> {
  const t0 = Date.now();
  let status = 0;
  while (Date.now() - t0 < maxMs) {
    const r = await call(ctx, "GET", `/projects/${ref}/config/auth`);
    status = r.status;
    if (status === 200) break;
    await sleep(10_000);
  }
  return { status, ms: Date.now() - t0 };
}

export type Cfg = Record<string, unknown>;

/** Only the mailer_* / smtp_* keys, with the SMTP password reduced to presence. */
export function mailView(cfg: Cfg): Cfg {
  const out: Cfg = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!/^(mailer_|smtp_)/.test(k)) continue;
    out[k] = k === "smtp_pass" ? (v ? "<set>" : v) : v;
  }
  return out;
}

export async function getAuth(ctx: Ctx, ref: string): Promise<{ status: number; cfg: Cfg }> {
  const r = await call(ctx, "GET", `/projects/${ref}/config/auth`);
  const cfg = (r.json && !Array.isArray(r.json) ? (r.json as Cfg) : {}) as Cfg;
  return { status: r.status, cfg };
}

/** PATCH config/auth. Non-2xx bodies are error text and are kept verbatim (trimmed); 2xx bodies are config and are not. */
export async function patchAuth(
  ctx: Ctx,
  ref: string,
  body: Cfg,
): Promise<{ status: number; ok: boolean; summary: string; cfg: Cfg }> {
  const r = await call(ctx, "PATCH", `/projects/${ref}/config/auth`, body);
  const ok = r.status >= 200 && r.status < 300;
  const cfg = (ok && r.json && !Array.isArray(r.json) ? (r.json as Cfg) : {}) as Cfg;
  return { status: r.status, ok, summary: ok ? `HTTP ${r.status}` : `HTTP ${r.status}: ${r.text.slice(0, 400)}`, cfg };
}

/** A harmless template that still carries the action variable. */
export function sampleTemplate(kind: TemplateKind, tag: string): string {
  const v = kind === "reauthentication" ? "{{ .Token }}" : "{{ .ConfirmationURL }}";
  return `<h2>lab ${kind} ${tag}</h2><p>Follow this link: ${v}</p>`;
}

export const DUMMY_SMTP = {
  smtp_host: "smtp.example.com",
  smtp_port: "587",
  smtp_user: "lab-user",
  smtp_pass: "lab-dummy-pass",
  smtp_admin_email: "noreply@example.com",
  smtp_sender_name: "lab",
} as const;

export const CLEAR_SMTP = {
  smtp_host: null,
  smtp_port: null,
  smtp_user: null,
  smtp_pass: null,
  smtp_admin_email: null,
  smtp_sender_name: null,
} as const;
