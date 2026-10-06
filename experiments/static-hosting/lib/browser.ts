/**
 * The browser half of HS05/HS06: run site/browser-check.ts (headless
 * Chromium, a subprocess because the compiled binary cannot bundle
 * Playwright) and turn its JSON line into a TestResult row.
 */
import { resolve } from "node:path";
import type { TestResult } from "../../../harness/src/types";

export interface Check {
  url: string;
  status: number;
  headerType: string;
  docType: string;
  rendered: boolean;
  h1: string | null;
  island: string | null;
  hydrated: boolean;
  api: string | null;
  cssApplied: boolean;
  fontLoaded: boolean;
  consoleErrors: string[];
  failed: string[];
  about: { status: number; docType: string; h1: string | null; url: string } | null;
}

export async function browserCheck(url: string, shot: string, pin?: string): Promise<Check | { error: string }> {
  const proc = Bun.spawn(["bun", resolve("site/browser-check.ts"), url, shot], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PVLAB_RESOLVE: pin ?? "" },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Check;
  } catch {
    return { error: `checker: ${(stderr || stdout).trim().slice(-300)}` };
  }
}

export function row(id: string, title: string, c: Check | { error: string }, expectRender: boolean, shot: string): TestResult {
  if ("error" in c) return { id, title, status: "fail", detail: c.error };
  const works = c.rendered && c.hydrated && c.cssApplied && !!c.about?.h1;
  const status = expectRender ? (works ? "pass" : "fail") : c.rendered ? "fail" : "pass";
  const seen = c.rendered
    ? `rendered "${c.h1}"; island ${c.island}; font ${c.cssApplied ? "applied" : "NOT applied"}; api ${c.api}; About -> ${c.about?.status ?? "-"} ${c.about?.h1 ? "rendered" : "not rendered"}`
    : `NOT rendered: document.contentType "${c.docType}" (header "${c.headerType}") - the visitor sees source text`;
  return {
    id,
    title,
    status,
    detail: `HTTP ${c.status}; ${seen}${c.failed.length ? `; failed: ${c.failed.slice(0, 4).join(", ")}` : ""}`,
    measurements: {
      status: c.status,
      header_type: c.headerType || "none",
      doc_type: c.docType || "none",
      rendered: c.rendered ? 1 : 0,
      hydrated: c.hydrated ? 1 : 0,
      css_applied: c.cssApplied ? 1 : 0,
      font_loaded: c.fontLoaded ? 1 : 0,
      api: c.api ?? "none",
      failed_requests: c.failed.length,
      console_errors: c.consoleErrors.length,
      about_status: c.about?.status ?? 0,
      about_doc_type: c.about?.docType || "none",
      about_rendered: c.about?.h1 ? 1 : 0,
      screenshot: shot,
    },
    evidence: JSON.stringify({ failed: c.failed, consoleErrors: c.consoleErrors, about: c.about }),
  };
}

