/**
 * WAL position arithmetic for RP08 (16 MB segments, the setting RP06a read on
 * every RP06 project, 2026-10-22/23 UTC). Pure functions, unit-tested in
 * wal.test.ts.
 */
const SEG = 16 * 1024 * 1024;
const SEGS_PER_XLOGID = 2 ** 32 / SEG; // 256

/** "0/501CA08" -> 83995144, or null when it is not an LSN. */
export function lsnNum(lsn: string): number | null {
  const m = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(lsn.trim());
  if (!m) return null;
  return parseInt(m[1] as string, 16) * 2 ** 32 + parseInt(m[2] as string, 16);
}

export function fmtLsn(n: number): string {
  const hi = Math.floor(n / 2 ** 32);
  const lo = n - hi * 2 ** 32;
  return `${hi.toString(16).toUpperCase()}/${lo.toString(16).toUpperCase()}`;
}

/** Segment number (timeline-independent) holding this LSN. */
export function segOfLsn(n: number): number {
  return Math.floor(n / SEG);
}

/** Segment number from a WAL file name (TTTTTTTTXXXXXXXXYYYYYYYY), or null. */
export function segOfWalName(name: string): number | null {
  if (!/^[0-9A-F]{24}$/i.test(name)) return null;
  return parseInt(name.slice(8, 16), 16) * SEGS_PER_XLOGID + parseInt(name.slice(16, 24), 16);
}

/** The LSN after `WAL location (LSN)` in a Postgres recovery log line, or null. */
export function stopLsnFromLog(line: string): string | null {
  const m = /WAL location \(LSN\) "?([0-9A-F]{1,8}\/[0-9A-F]{1,8})"?/i.exec(line);
  return m ? (m[1] as string) : null;
}

/**
 * When was this WAL position written? Linear interpolation over (time, LSN)
 * samples taken during the write phase; null outside the sampled range.
 */
export function timeAtLsn(series: { t: number; lsn: number }[], lsn: number): number | null {
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1] as { t: number; lsn: number };
    const b = series[i] as { t: number; lsn: number };
    if (lsn >= a.lsn && lsn <= b.lsn) {
      if (b.lsn === a.lsn) return a.t;
      return a.t + ((lsn - a.lsn) / (b.lsn - a.lsn)) * (b.t - a.t);
    }
  }
  return null;
}
