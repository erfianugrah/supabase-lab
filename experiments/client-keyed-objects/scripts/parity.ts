#!/usr/bin/env bun
/**
 * One parity table from CK run artifacts (offline; reads JSON only).
 *
 *   bun scripts/parity.ts <run.json> [<run.json> ...] [--out parity.md]
 *
 * Rows are assertions (CK01-CK13), columns are targets, cells are the status
 * the run recorded plus the one value that makes the cell comparable. Below
 * it: refusal shapes (CK02) and error shapes (CK12) that differ between
 * targets, each with the version gap of the service that produced it (CK13),
 * and the transfer and timing columns of CK04-CK06 marked as single-vantage
 * info. Every value is copied from an artifact; nothing is computed except
 * equality and the version pairing.
 */
import type { RunArtifact, TestResult } from "../../../harness/src/types";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
const files = args.filter((a, i) => a.endsWith(".json") && (outIdx < 0 || i !== outIdx + 1));
const ORDER = ["onprem", "onprem-file", "region-a", "region-b"];

const results: TestResult[] = [];
const sources: string[] = [];
for (const f of files) {
  const run = JSON.parse(await Bun.file(f).text()) as RunArtifact;
  results.push(...run.results);
  sources.push(`${f.split("/").slice(-2).join("/")} (started ${run.startedAt})`);
}
const targetOf = (r: TestResult) => String(r.measurements?.target ?? "");
const targets = ORDER.filter((t) => results.some((r) => targetOf(r) === t));
// Artifacts are given oldest first; a later run of the same row supersedes an earlier one.
const by = (id: string, t: string) => results.findLast((r) => r.id === `${id}-${t}`);
const m = (id: string, t: string, k: string) => by(id, t)?.measurements?.[k];
const cell = (s: unknown) => String(s ?? "-").replace(/\|/g, "\\|");

const out: string[] = [];
out.push("# client-keyed-objects - parity table", "");
out.push(`Sources: ${sources.join("; ")}.`, "");
out.push(`| assertion | ${targets.join(" | ")} |`, `|---|${targets.map(() => "---").join("|")}|`);
const extra: Record<string, (t: string) => string> = {
  CK01: (t) => String(m("CK01", t, "catalogue_sha") ?? ""),
  CK02: (t) => `alg ${m("CK02", t, "b_token_alg") ?? "?"}`,
  CK04: (t) => `killed at ${m("CK04", t, "killed_at_fraction") ?? "?"}, ${m("CK04", t, "parts_skipped") ?? "?"} parts kept`,
  CK05: (t) => `killed at ${m("CK05", t, "killed_at_fraction") ?? "?"}, offset ${m("CK05", t, "tus_offset_at_resume") ?? "?"}`,
  CK11: (t) => `ETags via ${m("CK11", t, "page.upload_etag_source") ?? "?"}`,
  CK13: (t) => `storage ${m("CK13", t, "live.storage") ?? "?"}`,
};
const TITLES: Record<string, string> = {
  CK01: "CK01 catalogue after migrations",
  CK02: "CK02 auth flows, hook claim",
  CK03: "CK03 RLS matrix (catalogue + objects)",
  CK04: "CK04 2 GiB S3 multipart, kill, resume, verify",
  CK05: "CK05 2 GiB TUS, kill, resume, verify",
  CK06: "CK06 100 ranged reads across 4 paths",
  CK07: "CK07 tamper fails closed",
  CK08: "CK08 ciphertext only",
  CK09: "CK09 key service down",
  CK10: "CK10 region isolation",
  CK11: "CK11 browser",
  CK12: "CK12 error shapes (recorded)",
  CK13: "CK13 versions (recorded)",
};
for (const id of Object.keys(TITLES)) {
  const cells = targets.map((t) => {
    let r = by(id, t);
    if (id === "CK10") r = results.findLast((x) => x.id.startsWith(`CK10-${t}-to-`)) ?? r;
    if (!r) return "not measured";
    const e = extra[id]?.(t);
    return `${r.status}${e ? ` (${e})` : ""}`;
  });
  out.push(`| ${TITLES[id]} | ${cells.map(cell).join(" | ")} |`);
}
const code = results.filter((r) => r.id === "CK01-code");
if (code.length) out.push(`| CK01 no target branch in client/migrations (once per run) | ${code.at(-1)!.status}, ${code.length} runs: ${code.map((c) => c.status).join("/")} |`);
out.push("");

// Versions
const SVC = ["auth", "rest", "storage", "postgres"];
out.push("## Versions (CK13)", "", `| service | ${targets.join(" | ")} |`, `|---|${targets.map(() => "---").join("|")}|`);
for (const s of SVC) out.push(`| ${s} (live) | ${targets.map((t) => cell(m("CK13", t, `live.${s}`))).join(" | ")} |`);
const imgKey: Record<string, string> = { auth: "image.auth", rest: "image.rest", storage: "image.storage", postgres: "image.db" };
for (const s of SVC) out.push(`| ${s} (image tag) | ${targets.map((t) => cell(m("CK13", t, imgKey[s]!))).join(" | ")} |`);
out.push("");
const ver = (t: string, svc: string) => String(m("CK13", t, `live.${svc}`) ?? "?");
const gap = (svc: string) => targets.map((t) => `${t} ${ver(t, svc)}`).join(" / ");

// Differences with version gap
const diffRows = (id: string, keys: string[], svcOf: (k: string) => string) => {
  const rows: string[] = [];
  for (const k of keys) {
    const vals = targets.map((t) => String(m(id, t, k) ?? "-"));
    if (new Set(vals.filter((v) => v !== "-")).size > 1) rows.push(`| ${k} | ${vals.map(cell).join(" | ")} | ${svcOf(k)}: ${gap(svcOf(k))} |`);
  }
  return rows;
};
const ck12keys = [...new Set(results.filter((r) => r.id.startsWith("CK12-") && r.id !== "CK12-diff").flatMap((r) => Object.keys(r.measurements ?? {})))].filter((k) => k !== "target");
const svcOf = (k: string) => ({ auth: "auth", rest: "rest", storage: "storage", s3: "storage" })[k.split(".")[0]!] ?? "?";
const d12 = diffRows("CK12", ck12keys, svcOf);
out.push("## Error shapes that differ (CK12), with the version gap", "", "Cell: `status media-type body-keys code`.", "");
out.push(`| request | ${targets.join(" | ")} | version gap |`, `|---|${targets.map(() => "---").join("|")}|---|`);
out.push(...(d12.length ? d12 : [`| (none) | ${targets.map(() => "").join(" | ")} | |`]), "");
const ck02keys = ["d_wrong_password", "e_disabled_user", "f_expired_auth_user", "f_expired_rest", "b_claim_keys", "b_token_alg"];
const d02 = diffRows("CK02", ck02keys, (k) => (k.endsWith("rest") ? "rest" : "auth"));
out.push("## Auth refusal shapes and claims that differ (CK02)", "", `| field | ${targets.join(" | ")} | version gap |`, `|---|${targets.map(() => "---").join("|")}|---|`);
out.push(...(d02.length ? d02 : [`| (none) | ${targets.map(() => "").join(" | ")} | |`]), "");

// Single-vantage info
out.push("## Transfer and timing (info: one laptop vantage, n = 1 per target; not throughput claims)", "");
out.push(`| measurement | ${targets.join(" | ")} |`, `|---|${targets.map(() => "---").join("|")}|`);
const info: [string, string][] = [
  ["CK04", "info_upload_wall_s"],
  ["CK04", "info_upload_mib_per_s"],
  ["CK04", "info_read_mib_per_s"],
  ["CK04", "read_all_transferred"],
  ["CK04", "read_all_ciphertext_marker_hits"],
  ["CK05", "read_all_ciphertext_marker_hits"],
  ["CK05", "info_upload_wall_s"],
  ["CK05", "info_upload_mib_per_s"],
  ["CK05", "info_read_mib_per_s"],
];
for (const [id, k] of info) out.push(`| ${id} ${k} | ${targets.map((t) => cell(m(id, t, k))).join(" | ")} |`);
for (const p of ["s3", "s3-presigned", "signed-url", "authenticated"]) {
  for (const k of ["info_ms_p50", "info_ms_p95", "body_bytes_total", "covering_chunk_bytes_total", "cf_cache_status"]) {
    out.push(`| CK06 ${p}.${k} | ${targets.map((t) => cell(m("CK06", t, `${p}.${k}`))).join(" | ")} |`);
  }
}
out.push(`| CK06 plaintext_bytes_asked | ${targets.map((t) => cell(m("CK06", t, "plaintext_bytes_asked"))).join(" | ")} |`, "");

// Browser
out.push("## Browser surface (CK11)", "", `| field | ${targets.join(" | ")} |`, `|---|${targets.map(() => "---").join("|")}|`);
for (const k of ["page.upload", "page.upload_etag_source", "page.read.signed-url", "page.read.s3", "page.read.authenticated", "page.signed_get_readable_headers", "preflight.s3_put", "preflight.signed_url_get", "preflight.authenticated_get"]) {
  out.push(`| ${k} | ${targets.map((t) => cell(m("CK11", t, k))).join(" | ")} |`);
}
out.push("");

const md = out.join("\n");
if (outPath) await Bun.write(outPath, md);
console.log(md);
