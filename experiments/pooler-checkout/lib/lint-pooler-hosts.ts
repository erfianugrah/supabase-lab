#!/usr/bin/env bun
/**
 * Flags hard-coded Supavisor pooler hostnames (aws-0-<region>.pooler.supabase.com).
 *
 * Why: the host a tenant lives on is a property of the PROJECT, returned by
 * GET /v1/projects/{ref}/config/database/pooler (`db_host`). The same tenant
 * dialled on a different cluster prefix is refused (PC04b measured
 * `(ENOTFOUND) tenant/user <user> not found`), so a literal host in source or
 * in a checked-in connection string is a latent outage the day the project's
 * cluster differs from the literal.
 *
 *   bun lib/lint-pooler-hosts.ts [--all-prefixes] <file-or-dir>...
 *
 * Default flags `aws-0-*` only. `--all-prefixes` flags any `aws-<n>-*` literal.
 * Exit 1 when anything is flagged, 2 on usage error. Skips node_modules, .git,
 * evidence, out, binary-looking files and files over 1 MiB.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Hit {
  file: string;
  line: number;
  host: string;
  text: string;
}

const LEGACY = /\baws-0-[a-z0-9-]+\.pooler\.supabase\.com\b/g;
const ANY = /\baws-\d+-[a-z0-9-]+\.pooler\.supabase\.com\b/g;

/** Pure: scan one text blob. Lines containing `lint-pooler-hosts: allow` are skipped. */
export function findPoolerHosts(file: string, text: string, allPrefixes = false): Hit[] {
  const re = new RegExp((allPrefixes ? ANY : LEGACY).source, "g");
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("lint-pooler-hosts: allow")) continue;
    for (const m of line.matchAll(re)) hits.push({ file, line: i + 1, host: m[0], text: line.trim().slice(0, 160) });
  }
  return hits;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "evidence", "out", "dist", ".terraform"]);

export function walk(path: string, out: string[] = []): string[] {
  const st = statSync(path);
  if (st.isFile()) {
    if (st.size <= 1024 * 1024) out.push(path);
    return out;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(join(path, name), out);
  }
  return out;
}

export function lintPaths(paths: string[], allPrefixes = false): Hit[] {
  const hits: Hit[] = [];
  for (const p of paths)
    for (const f of walk(p)) {
      const buf = readFileSync(f);
      if (buf.includes(0)) continue; // binary
      hits.push(...findPoolerHosts(f, buf.toString("utf8"), allPrefixes));
    }
  return hits;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const all = args.includes("--all-prefixes");
  const paths = args.filter((a) => !a.startsWith("--"));
  if (!paths.length) {
    console.error("usage: lint-pooler-hosts.ts [--all-prefixes] <file-or-dir>...");
    process.exit(2);
  }
  const hits = lintPaths(paths, all);
  for (const h of hits)
    console.log(`${h.file}:${h.line}: hard-coded pooler host ${h.host} - read db_host from GET /v1/projects/{ref}/config/database/pooler`);
  console.log(`${hits.length} hit(s)`);
  process.exit(hits.length ? 1 : 0);
}
