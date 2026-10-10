/**
 * Operator-in-the-loop watch: poll a token on a fixed probe set while a human
 * changes something in the dashboard (demotes the token's creator, deletes
 * the token), and record when each probe's answer changes.
 *
 * The interval bounds the resolution of every time reported: a change seen at
 * the Nth poll happened between poll N-1 and poll N. Callers report that
 * interval next to the number.
 */
import { call, denial } from "./http.js";

export interface WatchProbe {
  id: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

export interface Transition {
  probe: string;
  fromState: string;
  toState: string;
  atS: number;
}

export interface WatchResult {
  initial: Record<string, string>;
  final: Record<string, string>;
  transitions: Transition[];
  polls: number;
  seconds: number;
  intervalS: number;
}

export const watchSeconds = () => Number(process.env.PVLAB_SP_WATCH_S ?? 900);
export const watchIntervalS = () => Number(process.env.PVLAB_SP_WATCH_INTERVAL_S ?? 15);

export async function watch(
  token: string,
  probes: WatchProbe[],
  log: (m: string) => void,
  stopWhenAllChanged = true,
): Promise<WatchResult> {
  const intervalS = watchIntervalS();
  const total = watchSeconds();
  const t0 = Date.now();
  const initial: Record<string, string> = {};
  const last: Record<string, string> = {};
  const transitions: Transition[] = [];
  let polls = 0;
  let stable = 0;
  for (;;) {
    const state: Record<string, string> = {};
    for (const p of probes) {
      const r = await call(token, p.method, p.path, p.body);
      state[p.id] = `${r.status}${denial(r).denied ? "D" : ""}`;
    }
    polls++;
    const atS = Math.round((Date.now() - t0) / 1000);
    let changed = false;
    for (const p of probes) {
      const s = state[p.id]!;
      if (polls === 1) {
        initial[p.id] = s;
      } else if (last[p.id] !== s) {
        transitions.push({ probe: p.id, fromState: last[p.id]!, toState: s, atS });
        log(`  watch: ${p.id} ${last[p.id]} -> ${s} at ${atS}s`);
        changed = true;
      }
      last[p.id] = s;
    }
    const allChanged = probes.every((p) => initial[p.id] !== last[p.id]);
    stable = changed ? 0 : stable + 1;
    if (stopWhenAllChanged && allChanged && stable >= 3) break;
    if ((Date.now() - t0) / 1000 >= total) break;
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
  return { initial, final: { ...last }, transitions, polls, seconds: Math.round((Date.now() - t0) / 1000), intervalS };
}

export const fmt = (t: Transition[]) => t.map((x) => `${x.probe} ${x.fromState}->${x.toState}@${x.atS}s`).join("; ") || "none";
