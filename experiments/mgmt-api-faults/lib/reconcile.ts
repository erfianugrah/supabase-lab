/**
 * Orphan reconciler for throwaway projects.
 *
 * A client that loses a create's answer (MF02, MF04b, MF05a, MF07) leaves a
 * project upstream that nothing local knows about. The only place that sees
 * it is the org listing. This compares that listing against a local ledger of
 * the creates the client DID hear back about, and flags the rest.
 *
 * Ledger: JSON Lines, one object per create the client recorded as
 * successful: `{"name": "...", "ref": "..."}` (`ref` optional; the name is
 * unique within an org, MF02c). A tool appends a line when it hears a 2xx;
 * a create whose answer was lost writes nothing, which is the point.
 *
 * Classification of each listed project whose name starts with `prefix`
 * (and, with `org`, sits in that organization):
 *   tracked  a ledger line matches it by ref, or by name
 *   young    no ledger line, first seen by the reconciler less than `graceMs`
 *            ago: a create whose answer may still be in flight (the provider
 *            waited 130 s in MF05b), so not yet an orphan
 *   orphan   no ledger line and first seen at least `graceMs` ago
 * Projects outside the prefix are ignored, so the reconciler never reports,
 * and its caller never deletes, a project it was not asked about.
 *
 * Why "first seen" and not `created_at`: the listing's `created_at` for a
 * fresh project preceded the create request by 486 to 564 s (MF07e, 5
 * projects, 2026-10-23), so a "created after my run started" filter dropped
 * every orphan, and a grace window measured from `created_at` would call a
 * project seconds old an orphan. The first-seen times live in a small JSON
 * state file the caller keeps between runs (`--state`); without one, every
 * unmatched project is first seen now.
 *
 * Read-only against the API: it lists and reports. Deleting is the caller's
 * decision (`make sweep` deletes by prefix).
 *
 *   bun lib/reconcile.ts --ledger <file> --prefix mf- [--state <file>] [--grace-s 300] [--org <slug>]
 *
 * `--org` (default PVLAB_ORG_PRO) keeps the check to one organization; a PAT
 * lists every org its owner belongs to.
 *
 * Exit 0 with no orphans, 3 when there are orphans (so a cron job or CI step
 * can alert on the exit code), 1 on error.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Listed {
  ref: string;
  name: string;
  created_at: string;
  status?: string;
  org?: string;
}

export interface LedgerEntry {
  name: string;
  ref?: string;
}

export interface Reconciled {
  tracked: Listed[];
  young: Listed[];
  orphan: Listed[];
  /** Ledger entries with no listed project (deleted, or never created). */
  absent: LedgerEntry[];
}

/** ref -> epoch ms the reconciler first listed it without a ledger match. */
export type FirstSeen = Record<string, number>;

export function reconcile(
  listed: Listed[],
  ledger: LedgerEntry[],
  opts: { prefix: string; now?: Date; graceMs?: number; org?: string; firstSeen?: FirstSeen },
): Reconciled & { firstSeen: FirstSeen } {
  const now = (opts.now ?? new Date()).getTime();
  const grace = opts.graceMs ?? 300_000;
  const prior = opts.firstSeen ?? {};
  const firstSeen: FirstSeen = {};
  const byRef = new Set(ledger.map((e) => e.ref).filter((r): r is string => !!r));
  const byName = new Set(ledger.map((e) => e.name));
  const out: Reconciled = { tracked: [], young: [], orphan: [], absent: [] };
  const seen = new Set<string>();
  for (const p of listed) {
    if (!p.name.startsWith(opts.prefix)) continue;
    if (opts.org && p.org !== opts.org) continue;
    if (byRef.has(p.ref) || byName.has(p.name)) {
      out.tracked.push(p);
      seen.add(p.ref);
      seen.add(p.name);
      continue;
    }
    // Unmatched: carry the first sighting forward; refs no longer listed drop out.
    const first = prior[p.ref] ?? now;
    firstSeen[p.ref] = first;
    if (now - first < grace) out.young.push(p);
    else out.orphan.push(p);
  }
  for (const e of ledger) {
    if (!(e.ref && seen.has(e.ref)) && !seen.has(e.name)) out.absent.push(e);
  }
  return { ...out, firstSeen };
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LedgerEntry);
}

/** GET /v1/projects, mapped to the fields the reconciler reads. */
export async function listProjects(pat: string, base = "https://api.supabase.com/v1"): Promise<Listed[]> {
  const r = await fetch(`${base}/projects`, {
    headers: { Authorization: `Bearer ${pat}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`GET /projects answered ${r.status}`);
  const arr = (await r.json()) as Array<{ id?: string; ref?: string; name?: string; created_at?: string; status?: string; organization_slug?: string }>;
  return arr.map((p) => ({ ref: p.ref ?? p.id ?? "", name: p.name ?? "", created_at: p.created_at ?? "", status: p.status, org: p.organization_slug }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ledgerPath = arg("--ledger");
  const prefix = arg("--prefix") ?? "mf-";
  const statePath = arg("--state");
  const graceS = Number(arg("--grace-s") ?? 300);
  const org = arg("--org") ?? process.env.PVLAB_ORG_PRO;
  const pat = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ledgerPath || !pat) {
    console.error("usage: SUPABASE_ACCESS_TOKEN=... bun lib/reconcile.ts --ledger <file> [--prefix mf-] [--state <file>] [--grace-s 300] [--org slug]");
    process.exit(1);
  }
  try {
    const prior = statePath && existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as FirstSeen) : {};
    const res = reconcile(await listProjects(pat), readLedger(ledgerPath), { prefix, graceMs: graceS * 1000, org, firstSeen: prior });
    if (statePath) writeFileSync(statePath, JSON.stringify(res.firstSeen));
    const { firstSeen: _drop, ...report } = res;
    console.log(JSON.stringify(report, null, 2));
    process.exit(res.orphan.length ? 3 : 0);
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }
}
