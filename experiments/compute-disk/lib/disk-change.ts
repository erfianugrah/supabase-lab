/**
 * Pure helpers for D13 (a live disk IOPS/throughput change sampled on every
 * connection path). Everything here is offline and unit tested in
 * disk-change.test.ts; the module and lib/continuous.ts do the I/O.
 *
 *  - gp3 sizing: the platform validates `iops` against the volume size
 *    (D11, 2026-10-01: `Invalid IOPS value for gp3 volume 3000. Minimum is
 *    3000. Max is 500 IOPS per GB or 80,000, whichever is lower.`), so a
 *    fresh 2 GB project cannot take ANY disk write until it is at least 6 GB,
 *    and 6,000 IOPS needs 12 GB.
 *  - the four-hour refusal (D03): `Database disk can only be modified once
 *    per four hours. Last modified at <UTC>` - parsed so the module can wait
 *    exactly as long as the platform says.
 *  - per-path, per-phase statistics on top of outage.ts (which owns outage
 *    attribution): longest gap between successful samples, latency.
 *  - node_exporter text from the project's metrics endpoint, reduced to the
 *    disk and CPU counters a write load moves.
 */
import { attribute, type PhaseMark } from "./outage";

export interface DiskAttrs {
  type?: string;
  size_gb?: number;
  iops?: number;
  throughput_mibps?: number;
}

export const GP3_MIN_IOPS = 3000;
export const GP3_IOPS_PER_GB = 500;

/** Smallest gp3 volume (GB) on which the platform accepts `iops`. */
export function minSizeGbForIops(iops: number): number {
  return Math.ceil(Math.max(iops, GP3_MIN_IOPS) / GP3_IOPS_PER_GB);
}

/** True when every attribute set in `target` reads back equal in `got`. */
export function attrsReached(got: DiskAttrs | undefined, target: DiskAttrs): boolean {
  if (!got) return false;
  return (Object.keys(target) as (keyof DiskAttrs)[]).every((k) => target[k] === undefined || got[k] === target[k]);
}

const WORD_HOURS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, twelve: 12, "twenty-four": 24,
};

export interface Cooldown {
  /** "once per four hours" -> 4; null when the text names no period. */
  hours: number | null;
  /** Parsed "Last modified at ..." as epoch ms; null when absent or unparseable. */
  lastModifiedMs: number | null;
  /** The raw timestamp text after "Last modified at", for the record. */
  lastModifiedText: string;
}

/** Pure: a refusal body (JSON or plain) -> the period and the last modification it names. */
export function parseCooldown(body: string): Cooldown {
  let text = body;
  try {
    const j = JSON.parse(body) as { message?: unknown };
    if (typeof j.message === "string") text = j.message;
  } catch {
    // plain text
  }
  const per = /once per (\S+?) hours?/i.exec(text);
  let hours: number | null = null;
  if (per?.[1]) {
    const w = per[1].toLowerCase();
    hours = /^\d+$/.test(w) ? Number(w) : (WORD_HOURS[w] ?? null);
  }
  // 2026-11-04 the platform wrote `Last modified at 04-11-2026 09:35:09 UTC`:
  // day-month-year. Date.parse reads that as 11 April, so it is parsed by hand.
  const dmy = /Last modified at\s+((\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC)/i.exec(text);
  if (dmy) {
    const [, raw, dd, mm, yyyy, h, mi, s] = dmy as unknown as string[];
    const ms = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(h), Number(mi), Number(s));
    return { hours, lastModifiedMs: Number.isFinite(ms) ? ms : null, lastModifiedText: raw ?? "" };
  }
  const iso = /Last modified at\s+(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  const lm = iso ?? /Last modified at\s+(.+?)\s*\.?\s*$/i.exec(text.trim());
  const lastModifiedText = lm?.[1] ?? "";
  const ms = lastModifiedText ? Date.parse(lastModifiedText) : Number.NaN;
  return { hours, lastModifiedMs: Number.isFinite(ms) ? ms : null, lastModifiedText };
}

/** When the platform should accept the next disk write, by its own message; falls back to `fromMs` + default hours. */
export function nextAllowedMs(c: Cooldown, fromMs: number, defaultHours = 4): number {
  return (c.lastModifiedMs ?? fromMs) + (c.hours ?? defaultHours) * 3_600_000;
}

/** "try again in 3 minute(s)" -> 3 (the add-on refusal D09 met); null when absent. */
export function retryMinutes(body: string): number | null {
  const m = /try again in (\d+) minute/i.exec(body);
  return m ? Number(m[1]) : null;
}

export interface PathSample {
  /** Date.now() at the sample's start. */
  at: number;
  ok: boolean;
  /** Probe latency, ms. */
  ms: number;
  error?: string;
}

export interface PathPhaseStats {
  phase: string;
  startMs: number;
  endMs: number;
  samples: number;
  failures: number;
  outages: number;
  /** Longest run of failed samples that started in this phase, first failure to next success, s. */
  maxOutageS: number;
  maxOutageOpen: boolean;
  /** Longest time between two successful samples, the later one inside the phase, s. */
  maxGapS: number;
  p50Ms: number | null;
  maxMs: number | null;
  firstFailS: number | null;
}

const r3 = (ms: number) => Math.round(ms) / 1000;

export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] as number;
}

/**
 * Longest time between consecutive successful samples whose later member lies
 * in [from, to). The anchor is the last success before `from`, else `from`. A
 * phase with no success at all reports `to - anchor` (still down at its end).
 */
export function maxOkGapMs(samples: PathSample[], from: number, to: number): number {
  let prev: number | null = null;
  let max = 0;
  let any = false;
  for (const s of samples) {
    if (!s.ok) continue;
    if (s.at < from) {
      prev = s.at;
      continue;
    }
    if (s.at >= to) break;
    max = Math.max(max, s.at - (prev ?? from));
    prev = s.at;
    any = true;
  }
  if (!any) return to - (prev ?? from);
  return max;
}

/** Pure: one path's samples + the shared phase marks -> per-phase statistics. */
export function pathPhaseStats(samples: PathSample[], phases: PhaseMark[], endMs: number): PathPhaseStats[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const att = attribute(sorted, phases, endMs);
  return phases.map((p, i) => {
    const end = i + 1 < phases.length ? (phases[i + 1] as PhaseMark).startMs : endMs;
    const mine = sorted.filter((s) => s.at >= p.startMs && s.at < end);
    const okMs = mine.filter((s) => s.ok).map((s) => s.ms);
    const a = att[i];
    return {
      phase: p.name,
      startMs: p.startMs,
      endMs: end,
      samples: mine.length,
      failures: mine.filter((s) => !s.ok).length,
      outages: a?.outages ?? 0,
      maxOutageS: a?.maxOutageS ?? 0,
      maxOutageOpen: a?.maxOutageOpen ?? false,
      maxGapS: r3(maxOkGapMs(sorted, p.startMs, end)),
      p50Ms: quantile(okMs, 0.5),
      maxMs: okMs.length ? Math.max(...okMs) : null,
      firstFailS: a?.firstFailS ?? null,
    };
  });
}

/** Name of the phase a time falls in ("" before the first). */
export function phaseAt(phases: PhaseMark[], at: number): string {
  let name = "";
  for (const p of phases) if (at >= p.startMs) name = p.name;
  return name;
}

/** Every failed sample as one line: seconds after t0, UTC time, path, phase, error. Capped per path. */
export function failureLines(path: string, samples: PathSample[], phases: PhaseMark[], t0: number, cap = 300): string[] {
  const fails = samples.filter((s) => !s.ok);
  const out = fails.slice(0, cap).map(
    (s) => `+${((s.at - t0) / 1000).toFixed(3)}s ${new Date(s.at).toISOString()} ${path} [${phaseAt(phases, s.at)}] ${s.ms}ms ${s.error ?? "unknown"}`,
  );
  if (fails.length > cap) out.push(`${path}: ${fails.length - cap} more failures not listed`);
  return out;
}

export interface NodeSnap {
  /** node_time_seconds: the exporter's own clock when the snapshot was taken. */
  timeS: number;
  disks: Record<string, { writtenBytes: number; writes: number; readBytes: number; reads: number }>;
  cpuBusyS: number;
  cpuIdleS: number;
}

/** Pure: node_exporter text -> disk and CPU counters. */
export function parseNodeMetrics(text: string): NodeSnap {
  const snap: NodeSnap = { timeS: Number.NaN, disks: {}, cpuBusyS: 0, cpuIdleS: 0 };
  const disk = (dev: string) => (snap.disks[dev] ??= { writtenBytes: 0, writes: 0, readBytes: 0, reads: 0 });
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const name = line.split(/[{ ]/)[0] ?? "";
    const v = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (!Number.isFinite(v)) continue;
    if (name === "node_time_seconds") snap.timeS = v;
    else if (name.startsWith("node_disk_")) {
      const dev = /device="([^"]+)"/.exec(line)?.[1];
      if (!dev) continue;
      if (name === "node_disk_written_bytes_total") disk(dev).writtenBytes = v;
      else if (name === "node_disk_writes_completed_total") disk(dev).writes = v;
      else if (name === "node_disk_read_bytes_total") disk(dev).readBytes = v;
      else if (name === "node_disk_reads_completed_total") disk(dev).reads = v;
    } else if (name === "node_cpu_seconds_total") {
      if (line.includes('mode="idle"')) snap.cpuIdleS += v;
      else if (!line.includes('mode="steal"') && !line.includes('mode="guest')) snap.cpuBusyS += v;
    }
  }
  return snap;
}

export interface DiskDelta {
  device: string;
  seconds: number;
  writtenMB: number;
  writes: number;
  /** Averages over the whole snapshot window, which is wider than the load. */
  writeMBps: number;
  writeIops: number;
  cpuBusyFrac: number;
}

/** Pure: two snapshots -> the device that wrote the most, and averages over the window between them. */
export function diskDelta(a: NodeSnap, b: NodeSnap): DiskDelta | null {
  const seconds = b.timeS - a.timeS;
  if (!(seconds > 0)) return null;
  let best: DiskDelta | null = null;
  for (const [dev, d1] of Object.entries(b.disks)) {
    const d0 = a.disks[dev];
    if (!d0) continue;
    const wb = d1.writtenBytes - d0.writtenBytes;
    if (!best || wb / 1e6 > best.writtenMB) {
      const busy = b.cpuBusyS - a.cpuBusyS;
      const idle = b.cpuIdleS - a.cpuIdleS;
      best = {
        device: dev,
        seconds: Math.round(seconds * 1000) / 1000,
        writtenMB: Math.round(wb / 1e5) / 10,
        writes: d1.writes - d0.writes,
        writeMBps: Math.round(wb / 1e5 / seconds) / 10,
        writeIops: Math.round((d1.writes - d0.writes) / seconds),
        cpuBusyFrac: busy + idle > 0 ? Math.round((busy / (busy + idle)) * 1000) / 1000 : -1,
      };
    }
  }
  return best;
}

/** MB (1e6 bytes) per second, one decimal. */
export function mbps(bytes: number, ms: number): number {
  return ms > 0 ? Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10 : -1;
}
