/**
 * A minimal Hrana-over-HTTP stream for TD04's Turso-engine rows: one
 * statement per round trip on one server-side stream (the baton carries it),
 * so a transaction can open with `BEGIN CONCURRENT`, which @libsql/client's
 * transaction() cannot send (it only issues BEGIN DEFERRED / IMMEDIATE /
 * READ-ONLY). Same endpoint the fixture's readiness check uses
 * (`POST {url}/v2/pipeline`).
 *
 * `fetchFn` is injectable so the request/response handling is unit-tested
 * without a network.
 */

type HranaValue = { type: "null" } | { type: "integer"; value: string } | { type: "float"; value: number } | { type: "text"; value: string } | { type: "blob"; base64: string };

export function toHrana(v: string | number | boolean | null): HranaValue {
  if (v === null) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  return { type: "text", value: v };
}

export function fromHrana(v: HranaValue): string | number | null {
  switch (v.type) {
    case "null":
      return null;
    case "integer":
      return Number(v.value);
    case "float":
      return v.value;
    case "text":
      return v.value;
    case "blob":
      return `<blob>`;
  }
}

export interface HranaResult {
  cols: string[];
  rows: (string | number | null)[][];
  affected: number;
}

export class HranaError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export class HranaStream {
  private baton: string | null = null;
  private base: string;
  closed = false;
  constructor(
    url: string,
    private token: string,
    private fetchFn: FetchFn = (u, i) => fetch(u, i),
    private timeoutMs = 30_000,
  ) {
    this.base = url.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
  }

  private async pipeline(requests: unknown[]): Promise<{ type: string; response?: { result?: { cols?: { name?: string }[]; rows?: HranaValue[][]; affected_row_count?: number } }; error?: { message?: string; code?: string } }[]> {
    const r = await this.fetchFn(`${this.base}/v2/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ baton: this.baton, requests }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    if (!r.ok) {
      this.closed = true;
      throw new HranaError(`HTTP ${r.status} ${text.slice(0, 300)}`, `HTTP_${r.status}`);
    }
    const j = JSON.parse(text) as { baton?: string | null; base_url?: string | null; results?: unknown[] };
    this.baton = j.baton ?? null;
    if (j.base_url) this.base = j.base_url.replace(/\/+$/, "");
    if (!this.baton) this.closed = true;
    return (j.results ?? []) as never;
  }

  /** One statement, one round trip. Throws HranaError with the server's message and code. */
  async exec(sql: string, args: (string | number | boolean | null)[] = []): Promise<HranaResult> {
    if (this.closed) throw new HranaError("stream closed", "STREAM_CLOSED");
    const [res] = await this.pipeline([{ type: "execute", stmt: { sql, args: args.map(toHrana), want_rows: true } }]);
    if (!res) throw new HranaError("empty pipeline response", "EMPTY");
    if (res.type === "error") throw new HranaError(res.error?.message ?? "unknown error", res.error?.code);
    const result = res.response?.result ?? {};
    return {
      cols: (result.cols ?? []).map((c) => c.name ?? ""),
      rows: (result.rows ?? []).map((row) => row.map(fromHrana)),
      affected: result.affected_row_count ?? 0,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pipeline([{ type: "close" }]).catch(() => undefined);
  }
}

export interface TxOutcome {
  ok: boolean;
  /** Attempts used (1 = committed first time). */
  attempts: number;
  /** Attempts that failed with a conflict-shaped error and were retried. */
  conflicts: number;
  /** ms from first BEGIN to the final COMMIT (or give-up). */
  ms: number;
  /** Errors seen, verbatim (conflict or not), in order. */
  errors: string[];
}

/**
 * Run `body` inside `begin` ... COMMIT on a fresh stream, retrying while the
 * error is conflict-shaped (`retryable`), up to `maxAttempts`. A non-retryable
 * error stops at once. ROLLBACK is best effort; the stream is closed either way.
 */
export async function runTx(
  open: () => HranaStream,
  begin: string,
  body: (s: HranaStream) => Promise<void>,
  retryable: (text: string) => boolean,
  maxAttempts = 25,
  now: () => number = () => performance.now(),
): Promise<TxOutcome> {
  const t0 = now();
  const errors: string[] = [];
  let conflicts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const s = open();
    try {
      await s.exec(begin);
      await body(s);
      await s.exec("COMMIT");
      await s.close();
      return { ok: true, attempts: attempt, conflicts, ms: now() - t0, errors };
    } catch (e) {
      const text = e instanceof HranaError ? `${e.code ? `[${e.code}] ` : ""}${e.message}` : e instanceof Error ? e.message : String(e);
      errors.push(text.slice(0, 500));
      if (!s.closed) await s.exec("ROLLBACK").catch(() => undefined);
      await s.close();
      if (!retryable(text)) return { ok: false, attempts: attempt, conflicts, ms: now() - t0, errors };
      conflicts++;
    }
  }
  return { ok: false, attempts: maxAttempts, conflicts, ms: now() - t0, errors };
}
