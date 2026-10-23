/**
 * Delete leftover DC projects (a run that died before DC99).
 *
 *   SUPABASE_ACCESS_TOKEN=... bun lib/cleanup.ts            # list only
 *   SUPABASE_ACCESS_TOKEN=... bun lib/cleanup.ts --delete   # delete
 *
 * Scope is by name only: every project visible to the token whose name starts
 * with PVLAB_DC_PREFIX (default "pvlab-dc-") is listed and, with --delete,
 * deleted. Use a prefix no other project of yours shares.
 */
import { mgmt } from "../../../harness/src/mgmt.js";
import type { Ctx } from "../../../harness/src/types.js";

const pfx = process.env.PVLAB_DC_PREFIX || "pvlab-dc-";
const ctx = { pat: process.env.SUPABASE_ACCESS_TOKEN } as Ctx;
const list = await mgmt(ctx, "GET", "/projects");
const rows = (Array.isArray(list.json) ? list.json : []) as { id?: string; ref?: string; name?: string }[];
const mine = rows.filter((p) => (p.name ?? "").startsWith(pfx));
console.log(`projects with prefix "${pfx}": ${mine.length} (of ${rows.length} visible)`);
for (const p of mine) {
  const ref = p.ref ?? p.id ?? "";
  if (process.argv.includes("--delete")) {
    const d = await mgmt(ctx, "DELETE", `/projects/${ref}`);
    console.log(`  ${p.name}: DELETE -> ${d.status}`);
  } else {
    console.log(`  ${p.name}`);
  }
}
