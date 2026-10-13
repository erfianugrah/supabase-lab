/**
 * L02 support (work-supabase-lab#42): what a Management API rate-limit breach
 * looks like, per endpoint and burst shape.
 *
 * L01c saw the API's own JSON throttler (`429`, `{"message":"ThrottlerException:
 * Too Many Requests"}`, `retry-after: 60`) on a cheap scoped read. Other
 * experiments met an HTML page from the edge instead (harness/src/mgmt.ts
 * `classifyBody`). A client has to back off on both, but only the JSON one
 * says how long; this names which endpoints and shapes produce which.
 *
 * Pure: unit-tested in burst.test.ts.
 */
import { classifyBody } from "../../../harness/src/mgmt";

export type BodyClass = "json-throttler" | "json-other" | "html" | "empty" | "text";

export function bodyClass(contentType: string | null, body: string): BodyClass {
  if (!body.trim()) return "empty";
  const c = classifyBody(contentType, body);
  if (c.throttled) return "html";
  if (c.json === undefined) return "text";
  return /ThrottlerException/.test(body) ? "json-throttler" : "json-other";
}

export interface Sample {
  /** Issue order, 1-based. */
  n: number;
  status: number;
  contentType: string;
  retryAfter: string;
  rateLimitRemaining: string;
  /** Kept only for non-2xx samples, first 200 characters. */
  body: string;
}

export interface CellSummary {
  requests_sent: number;
  ok_2xx: number;
  first_non2xx_at: number | "none";
  first_non2xx_status: number | "none";
  first_non2xx_class: BodyClass | "none";
  first_non2xx_content_type: string;
  retry_after: string;
  statuses: string;
  classes: string;
  remaining_at_first: string;
}

function histogram(values: (string | number)[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, n]) => `${k}:${n}`).join("|") || "none";
}

/** Status 0 is a transport failure (timeout, reset), recorded as its own class. */
export function summariseCell(samples: Sample[]): CellSummary {
  const ordered = [...samples].sort((a, b) => a.n - b.n);
  const bad = ordered.filter((s) => s.status < 200 || s.status >= 300);
  const first = bad[0];
  const cls = (s: Sample) => (s.status === 0 ? ("text" as const) : bodyClass(s.contentType || null, s.body));
  return {
    requests_sent: ordered.length,
    ok_2xx: ordered.length - bad.length,
    first_non2xx_at: first ? first.n : "none",
    first_non2xx_status: first ? first.status : "none",
    first_non2xx_class: first ? cls(first) : "none",
    first_non2xx_content_type: first?.contentType || "none",
    retry_after: first?.retryAfter || "none",
    statuses: histogram(ordered.map((s) => s.status)),
    classes: histogram(bad.map(cls)),
    remaining_at_first: ordered[0]?.rateLimitRemaining || "none",
  };
}

export type Shape = "serial" | "parallel-20" | "spike-150";

/** How many requests a shape may issue and how many run at once. */
export const SHAPES: Record<Shape, { max: number; concurrency: number; stopOnFirstNon2xx: boolean }> = {
  serial: { max: 150, concurrency: 1, stopOnFirstNon2xx: true },
  "parallel-20": { max: 150, concurrency: 20, stopOnFirstNon2xx: true },
  "spike-150": { max: 150, concurrency: 150, stopOnFirstNon2xx: false },
};
