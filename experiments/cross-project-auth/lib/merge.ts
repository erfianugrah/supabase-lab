/**
 * Fan-out read and merge, shared verbatim by the local client and the Edge
 * Function (X04-X07). The Edge Function source is this file's text followed by
 * a `Deno.serve` handler (lib/fanout.ts `edgeSource`), so the client cells and
 * the Edge Function cells run the same merge code. Keep it free of imports and
 * of anything Bun- or Deno-specific: plain fetch, AbortSignal, bigint.
 *
 * Ordering is newest first by (created_at, id). PostgREST returns timestamptz
 * as text with microseconds (trailing zeros dropped), and JavaScript's Date
 * keeps milliseconds, so a comparator or a keyset cursor built from a Date
 * loses the sub-millisecond part. `cmpExact` and the raw-string cursor keep
 * it; `cmpMs` and `msCursor` are the lossy variants X06 measures.
 */

export interface Row {
  id: string;
  created_at: string;
  [k: string]: unknown;
}

export interface Target {
  name: string;
  /** Project base URL, `https://<host>`, no trailing slash. */
  url: string;
  /** apikey header value for that project. */
  anon: string;
  /** Table (or view) under /rest/v1. */
  table: string;
}

export interface Leg {
  name: string;
  status: number;
  ms: number;
  rows: number;
  code?: string;
  err?: string;
}

export interface FanResult {
  /** Every leg answered 200 with a rows array. */
  ok: boolean;
  /** At least one leg answered and at least one failed (policy "settled" only). */
  partial: boolean;
  rows: Row[];
  legs: Leg[];
  error?: string;
  ms: number;
}

export type Policy = "all" | "settled";

export interface Cursor {
  created_at: string;
  id: string;
}

/** PostgREST timestamptz text -> microseconds since the epoch. */
export function tsMicros(s: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s);
  if (!m) throw new Error(`unparsed timestamp: ${s}`);
  let tz = m[4] ?? "Z";
  if (/^[+-]\d{2}$/.test(tz)) tz += ":00";
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${tz}`);
  if (Number.isNaN(ms)) throw new Error(`unparsed timestamp: ${s}`);
  return BigInt(ms) * 1000n + BigInt((m[3] ?? "").padEnd(6, "0") || "0");
}

const idDesc = (a: Row, b: Row): number => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0);

/** Newest first, microsecond-exact, ties broken by id descending. */
export function cmpExact(a: Row, b: Row): number {
  const x = tsMicros(a.created_at);
  const y = tsMicros(b.created_at);
  if (x !== y) return x > y ? -1 : 1;
  return idDesc(a, b);
}

/** Newest first via Date.parse (millisecond precision), ties by id. The lossy variant. */
export function cmpMs(a: Row, b: Row): number {
  const x = Date.parse(a.created_at);
  const y = Date.parse(b.created_at);
  if (x !== y) return y - x;
  return idDesc(a, b);
}

/** The cursor a Date round-trip produces: milliseconds, `Z`. The lossy variant. */
export function msCursor(r: Row): Cursor {
  return { created_at: new Date(Date.parse(r.created_at)).toISOString(), id: r.id };
}

/** The cursor taken verbatim from the row PostgREST returned. */
export function exactCursor(r: Row): Cursor {
  return { created_at: r.created_at, id: r.id };
}

/** One page, newest first. `cursor` = keyset (rows strictly after it); `offset` = OFFSET paging. */
export function pageQuery(limit: number, opts: { cursor?: Cursor; offset?: number; select?: string } = {}): string {
  let q = `select=${opts.select ?? "id,created_at,body,src"}&order=created_at.desc,id.desc&limit=${limit}`;
  if (opts.cursor) {
    const c = opts.cursor;
    const tree = `(created_at.lt."${c.created_at}",and(created_at.eq."${c.created_at}",id.lt.${c.id}))`;
    q += `&or=${encodeURIComponent(tree)}`;
  }
  if (opts.offset) q += `&offset=${opts.offset}`;
  return q;
}

class LegFailure extends Error {
  constructor(readonly leg: Leg) {
    super(`${leg.name}: ${leg.status ? `HTTP ${leg.status}` : "no response"}${leg.code ? ` ${leg.code}` : ""}${leg.err ? ` ${leg.err}` : ""}`);
  }
}

async function readLeg(t: Target, bearer: string, qs: string, timeoutMs: number, t0: number): Promise<{ leg: Leg; rows: Row[] }> {
  try {
    const res = await fetch(`${t.url}/rest/v1/${t.table}?${qs}`, {
      headers: { apikey: t.anon, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (res.status !== 200 || !Array.isArray(json)) {
      const code = (json as { code?: string } | undefined)?.code;
      throw new LegFailure({ name: t.name, status: res.status, ms, rows: -1, code: code ?? undefined, err: text.replace(/\s+/g, " ").slice(0, 120) });
    }
    return { leg: { name: t.name, status: 200, ms, rows: json.length }, rows: json as Row[] };
  } catch (e) {
    if (e instanceof LegFailure) throw e;
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    // The request URL is dropped from the message: it is long and pushes the
    // cause (dns error, connection refused) past the truncation.
    const err = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\(?https?:\/\/[^\s)]*\)?/g, "<url>");
    throw new LegFailure({ name: t.name, status: 0, ms, rows: -1, err: err.slice(0, 160) });
  }
}

/**
 * Read every target in parallel, merge, sort, take `limit`.
 *
 * policy "all": the merged read fails as soon as any leg fails (Promise.all),
 * so `ms` is the time to the first failure. policy "settled": wait for every
 * leg, return what answered and flag `partial`.
 */
export async function fanout(
  targets: Target[],
  bearer: string,
  qs: string,
  limit: number,
  opts: { policy: Policy; timeoutMs: number; exact?: boolean },
): Promise<FanResult> {
  const t0 = performance.now();
  const legs: Leg[] = [];
  const cmp = opts.exact === false ? cmpMs : cmpExact;
  const runs = targets.map((t) =>
    readLeg(t, bearer, qs, opts.timeoutMs, t0).then(
      (r) => {
        legs.push(r.leg);
        return r;
      },
      (e: unknown) => {
        if (e instanceof LegFailure) legs.push(e.leg);
        throw e;
      },
    ),
  );
  const done = (r: Omit<FanResult, "ms" | "legs">): FanResult => ({ ...r, legs: [...legs], ms: Math.round((performance.now() - t0) * 10) / 10 });

  if (opts.policy === "all") {
    try {
      const parts = await Promise.all(runs);
      return done({ ok: true, partial: false, rows: parts.flatMap((p) => p.rows).sort(cmp).slice(0, limit) });
    } catch (e) {
      // The other legs keep running; their results are dropped. Swallow their
      // rejections so they do not surface as unhandled.
      for (const r of runs) r.catch(() => {});
      return done({ ok: false, partial: false, rows: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  const settled = await Promise.allSettled(runs);
  const okParts = settled.filter((s): s is PromiseFulfilledResult<{ leg: Leg; rows: Row[] }> => s.status === "fulfilled").map((s) => s.value);
  const errs = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => (s.reason instanceof Error ? s.reason.message : String(s.reason)));
  return done({
    ok: errs.length === 0,
    partial: errs.length > 0 && okParts.length > 0,
    rows: okParts.flatMap((p) => p.rows).sort(cmp).slice(0, limit),
    error: errs.length ? errs.join("; ") : undefined,
  });
}
