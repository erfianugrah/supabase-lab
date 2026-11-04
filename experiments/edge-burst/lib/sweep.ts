/**
 * List or delete leftover edge-burst projects (a run that died before EB99).
 *
 *   SUPABASE_ACCESS_TOKEN=... bun lib/sweep.ts            # list only
 *   SUPABASE_ACCESS_TOKEN=... bun lib/sweep.ts --delete   # delete
 *
 * Scope is by name only: every project visible to the token whose name starts
 * with PVLAB_EB_PREFIX (default "ef-burst-"). Names are printed, refs are not.
 */
import type { Ctx } from "../../../harness/src/types.js";
import { mgmtPatient, prefix } from "./eb.js";

const pfx = prefix();
const ctx = { pat: process.env.SUPABASE_ACCESS_TOKEN } as Ctx;
const list = await mgmtPatient(ctx, "GET", "/projects");
if (list.status !== 200) {
  console.error(`GET /projects: HTTP ${list.status}`);
  process.exit(1);
}
const rows = (Array.isArray(list.json) ? list.json : []) as { id?: string; ref?: string; name?: string; status?: string }[];
const mine = rows.filter((p) => (p.name ?? "").startsWith(pfx));
console.log(`projects with prefix "${pfx}": ${mine.length} (of ${rows.length} visible)`);
for (const p of mine) {
  if (process.argv.includes("--delete")) {
    const d = await mgmtPatient(ctx, "DELETE", `/projects/${p.ref ?? p.id ?? ""}`);
    console.log(`  ${p.name}: DELETE -> ${d.status}`);
  } else {
    console.log(`  ${p.name} (${p.status ?? "?"})`);
  }
}
