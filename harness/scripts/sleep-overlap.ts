/**
 * Place each test of a pvlab run artifact on the wall clock and list the
 * macOS sleeps it spans (#211). durationMs comes from performance.now(), which
 * does not advance while the Mac sleeps, so walking the tests forward from
 * startedAt and jumping every sleep reproduces finishedAt; the last line per
 * artifact shows how close. The first line (sleeps inside the run's wall span)
 * holds for any artifact; the per-test placement only when tests ran one after
 * another in one process (a --merge artifact or parallel parts will not close).
 *
 * pm-events.tsv: one event per line, `<UTC ISO time>\t<Sleep|Wake|DarkWake>`
 * (a third column, the sleep reason, is ignored), converted from the
 * `pmset -g log` lines of those three kinds, minus "Wake Requests". The
 * published one is platform-downtime/out/2026-10-23/host-sleep/pm-events.tsv.
 *
 *   bun harness/scripts/sleep-overlap.ts pm-events.tsv out/<date>/run-*.json
 *   bun harness/scripts/sleep-overlap.ts --trim trimmed.tsv full.tsv out/*\/run-*.json
 *
 * `--trim` writes only the events within 5 min of an artifact's run window
 * (plus both ends of any sleep overlapping one), which is all the placement
 * needs: a full day of sleep and wake times is the operator's activity
 * pattern and does not belong in a public repo.
 *
 * Artifacts written since #211 carry `host_suspended_s` themselves.
 */
const argv = process.argv.slice(2);
const trimOut = argv[0] === "--trim" ? argv[1] : undefined;
const [evFile, ...arts] = trimOut ? argv.slice(2) : argv;
const ev = (await Bun.file(evFile!).text()).trim().split("\n").map((line) => {
  const [ts, kind] = line.split("\t");
  return { t: Date.parse(ts!), kind: kind!, line };
});
const sleeps: { s: number; e: number; i: number; j: number }[] = [];
for (let i = 0; i < ev.length; i++) if (ev[i]!.kind === "Sleep") {
  const j = ev.findIndex((x, k) => k > i && x.kind !== "Sleep");
  if (j > 0) sleeps.push({ s: ev[i]!.t, e: ev[j]!.t, i, j });
}
if (trimOut) {
  const MARGIN_MS = 5 * 60_000;
  const windows = await Promise.all(
    arts.map(async (f) => {
      const a = JSON.parse(await Bun.file(f).text());
      return { from: Date.parse(a.startedAt) - MARGIN_MS, to: Date.parse(a.finishedAt) + MARGIN_MS };
    }),
  );
  const keep = new Set<number>();
  ev.forEach((e, k) => windows.some((w) => e.t >= w.from && e.t <= w.to) && keep.add(k));
  for (const sl of sleeps) if (windows.some((w) => sl.e >= w.from && sl.s <= w.to)) keep.add(sl.i).add(sl.j);
  await Bun.write(trimOut, [...keep].sort((x, y) => x - y).map((k) => ev[k]!.line).join("\n") + "\n");
  console.log(`kept ${keep.size} of ${ev.length} events -> ${trimOut}`);
  process.exit(0);
}
const iso = (t: number) => new Date(t).toISOString().slice(11, 19);
for (const f of arts) {
  const a = JSON.parse(await Bun.file(f).text());
  let w = Date.parse(a.startedAt);
  const wallEnd = Date.parse(a.finishedAt);
  const inside = sleeps.filter((x) => x.e > w && x.s < wallEnd);
  const total = inside.reduce((n, x) => n + Math.min(x.e, wallEnd) - Math.max(x.s, w), 0);
  // Wall span against the summed test durations (consecutive equal durations
  // are one module, counted once): equal when the host never slept.
  const summed = (a.results as { durationMs?: number }[]).reduce(
    (acc, r) => (r.durationMs === acc.last ? acc : { n: acc.n + (r.durationMs ?? 0), last: r.durationMs }),
    { n: 0, last: undefined as number | undefined },
  ).n;
  console.log(
    `\n${f}  ${a.startedAt} -> ${a.finishedAt}  sleeps inside: ${inside.length}, ${Math.round(total / 1000)} s` +
      `; wall ${((wallEnd - w) / 1000).toFixed(1)} s, summed durationMs ${(summed / 1000).toFixed(1)} s`,
  );
  if (!inside.length) continue;
  // A module that returns several results stamps them all with one duration:
  // consecutive equal durations are one module run, placed once.
  const runs: { ids: string[]; durationMs: number }[] = [];
  for (const r of a.results) {
    const last = runs.at(-1);
    if (last && last.durationMs === r.durationMs) last.ids.push(r.id);
    else runs.push({ ids: [r.id], durationMs: r.durationMs ?? 0 });
  }
  for (const r of runs) {
    const start = w; let rem = r.durationMs; const hit: string[] = [];
    while (rem > 0) {
      const sl = sleeps.find((x) => x.e > w && x.s < w + rem);
      if (!sl) { w += rem; rem = 0; break; }
      if (sl.s > w) { rem -= sl.s - w; }
      hit.push(`sleep ${iso(sl.s)}-${iso(sl.e)} (${Math.round((sl.e - sl.s) / 1000)} s) at +${Math.round((Math.max(sl.s, start) - start) / 1000)} s`);
      w = sl.e;
    }
    console.log(`  ${r.ids.join(",")} wall ${iso(start)}-${iso(w)} (${Math.round((w - start) / 1000)} s, monotonic ${Math.round(r.durationMs / 1000)} s) ${hit.join("; ") || "no sleep"}`);
  }
  console.log(`  reconstructed end ${iso(w)} vs finishedAt ${iso(wallEnd)} (diff ${Math.round((wallEnd - w) / 1000)} s)`);
}
