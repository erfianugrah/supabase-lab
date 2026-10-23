/**
 * X06 - is the merged stream correct when paged? Keyset by (created_at, id)
 * across two projects, against the ground truth.
 *
 * SIDE: the X04 pair. Ground truth = every tenant-a row in A's `fan_all`
 * (the union), ordered by (created_at desc, id desc) in Postgres, read as
 * postgres. Seed shapes that stress the merge (lib/fanout.ts): exact
 * cross-project ties on created_at, and clusters of three rows inside one
 * millisecond spread over both projects.
 *
 * Strategies, each walked from the first page to exhaustion at PAGE rows per
 * page (cap 400 pages):
 *   keyset_exact       per leg `created_at < c OR (created_at = c AND id < i)`,
 *                      merge microsecond-exact, cursor = last row's text verbatim
 *   keyset_ms_cursor   same, but the cursor goes through a JS Date (milliseconds)
 *   keyset_ms_compare  Date comparator AND Date cursor (the naive JS path)
 *   offset             per leg OFFSET page*PAGE, merge, keep PAGE
 *   single_keyset      control: A's fan_all alone, keyset_exact, no merge
 *   edge_keyset_exact  keyset_exact with each page fetched by the Edge Function on A
 *
 * Per strategy: rows returned, distinct, duplicates, missing vs truth,
 * positions that differ from truth, and whether the sequence equals truth.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";
import { callFn, currentPair, skipWithoutPro } from "../lib/fanout.js";
import { exactCursor, fanout, msCursor, pageQuery, type Cursor, type Row, type Target } from "../lib/merge.js";

const PAGE = 20;
const CAP = 400;

const mod: TestModule = {
  id: "X06",
  title: "Fan-out pagination: keyset (created_at, id) across two projects vs ground truth",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const skip = skipWithoutPro(ctx, "X06");
    if (skip) return skip;
    const p = currentPair();
    if (!p || !p.tpaId) return [{ id: "X06", title: this.title, status: "skip", detail: "X04 did not set up the pair and trust in this process" }];
    const truth = p.truth.map((r) => r.id);
    const fan: Target[] = [
      { name: "a", url: p.a.url, anon: p.a.anon, table: "fan_items" },
      { name: "b", url: p.b.url, anon: p.b.anon, table: "fan_items" },
    ];
    const single: Target[] = [{ name: "a", url: p.a.url, anon: p.a.anon, table: "fan_all" }];
    const opts = { policy: "all" as const, timeoutMs: 15_000 };

    type Fetch = (page: number, cursor?: Cursor) => Promise<Row[] | string>;
    const walk = async (fetchPage: Fetch, cursorOf: (r: Row) => Cursor, useCursor: boolean) => {
      const seq: string[] = [];
      let cursor: Cursor | undefined;
      let pages = 0;
      let error = "";
      for (; pages < CAP; pages++) {
        const rows = await fetchPage(pages, useCursor ? cursor : undefined);
        if (typeof rows === "string") {
          error = rows;
          break;
        }
        seq.push(...rows.map((r) => r.id));
        if (rows.length < PAGE) {
          pages++;
          break;
        }
        cursor = cursorOf(rows[rows.length - 1] as Row);
      }
      return { seq, pages, error };
    };

    const client = (targets: Target[], exact: boolean): Fetch => async (page, cursor) => {
      const qs = pageQuery(PAGE, cursor ? { cursor } : { offset: page * PAGE });
      const r = await fanout(targets, p.tokA, qs, PAGE, { ...opts, exact });
      return r.ok ? r.rows : (r.error ?? "error");
    };
    const edge: Fetch = async (_page, cursor) => {
      const r = await callFn(p.a, p.tokA, { targets: fan, qs: pageQuery(PAGE, cursor ? { cursor } : {}), limit: PAGE, ...opts });
      return r.ok ? r.rows : (r.error ?? r.raw ?? `HTTP ${r.status}`);
    };

    const strategies: [string, Fetch, (r: Row) => Cursor, boolean][] = [
      ["keyset_exact", client(fan, true), exactCursor, true],
      ["keyset_ms_cursor", client(fan, true), msCursor, true],
      ["keyset_ms_compare", client(fan, false), msCursor, true],
      ["offset", client(fan, true), exactCursor, false],
      ["single_keyset", client(single, true), exactCursor, true],
      ["edge_keyset_exact", edge, exactCursor, true],
    ];

    const out: TestResult[] = [];
    for (const [name, f, cur, useCursor] of strategies) {
      const { seq, pages, error } = await walk(f, cur, useCursor);
      const seen = new Set(seq);
      const truthSet = new Set(truth);
      const missing = truth.filter((id) => !seen.has(id)).length;
      const dups = seq.length - seen.size;
      const extra = [...seen].filter((id) => !truthSet.has(id)).length;
      let diffPos = 0;
      for (let i = 0; i < Math.max(seq.length, truth.length); i++) if (seq[i] !== truth[i]) diffPos++;
      const equal = seq.length === truth.length && diffPos === 0;
      const expectEqual = name !== "offset" && name !== "keyset_ms_cursor" && name !== "keyset_ms_compare";
      out.push({
        id: `X06-${name}`,
        title: `${name}: page ${PAGE}, walked to exhaustion`,
        status: error ? "fail" : expectEqual ? (equal ? "pass" : "fail") : "info",
        detail: `${pages} pages, ${seq.length} rows returned (${seen.size} distinct) vs truth ${truth.length}; missing ${missing}, duplicates ${dups}, foreign ${extra}, positions differing ${diffPos}; equals truth: ${equal}${error ? `; error ${error.slice(0, 120)}` : ""}`,
        measurements: { pages, rows_returned: seq.length, distinct: seen.size, truth_rows: truth.length, missing, duplicates: dups, foreign: extra, positions_differing: diffPos, equals_truth: String(equal) },
      });
    }
    return out;
  },
};
export default mod;
