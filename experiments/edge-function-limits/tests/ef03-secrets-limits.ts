/**
 * EF03 - secrets: four limits, measured one at a time.
 *
 * "We hit the secrets limit" names one of four things, and the fix differs
 * for each. Each is probed at its documented boundary (accepted at N,
 * rejected at N+1) so the report says WHICH limit bit and with what error:
 *
 *   EF03a  reserved prefix: a name starting SUPABASE_ is refused
 *   EF03b  name length: 256 accepted, 257 refused
 *   EF03c  value size: 24,576 chars accepted, 24,577 refused
 *   EF03c2 the same 24,576 in three-byte characters (73,728 bytes, above the
 *          48 KiB = 49,152-byte figure that 24,576 two-byte characters would
 *          give) - tells whether the ceiling is characters or bytes, since the
 *          docs quote both as if they were the same number
 *   EF03d  count: filled to 100, the 101st is refused
 *
 * Each result carries the platform's error verbatim and the triage bucket
 * `secretLimitOf` puts it in, so the classifier is exercised on real text.
 *
 * DESTRUCTIVE: creates up to 100 secrets under PVLAB_EF03_ and deletes them
 * in finally. Any user secret that was on the project before the run is left
 * alone and counted toward the 100. The platform-managed SUPABASE_* entries
 * that GET /secrets lists are NOT counted - they do not count on the platform
 * side either (see the RUNLOG's EF03 correction).
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { DOCS_READ_AT, SECRETS } from "../lib/docs";
import { errorOf } from "../lib/ef";
import { secretLimitOf } from "../lib/triage";

const PREFIX = "PVLAB_EF03_";

interface Outcome {
  status: number;
  error: string;
}

async function post(ctx: Ctx, secrets: { name: string; value: string }[]): Promise<Outcome> {
  const r = await mgmt(ctx, "POST", `/projects/${ctx.ref}/secrets`, secrets, 60_000);
  return { status: r.status, error: r.status >= 300 ? errorOf(r.text) : "" };
}

async function names(ctx: Ctx): Promise<string[]> {
  const r = await mgmt(ctx, "GET", `/projects/${ctx.ref}/secrets`);
  return Array.isArray(r.json) ? (r.json as { name?: string }[]).map((s) => s.name ?? "").filter(Boolean) : [];
}

async function remove(ctx: Ctx, list: string[]): Promise<number> {
  let worst = 0;
  for (let i = 0; i < list.length; i += 50) {
    const r = await mgmt(ctx, "DELETE", `/projects/${ctx.ref}/secrets`, list.slice(i, i + 50), 60_000);
    worst = Math.max(worst, r.status);
  }
  return worst;
}

const accepted = (o: Outcome) => o.status < 300;
const refused = (o: Outcome) => o.status >= 400;

function boundary(
  id: string,
  title: string,
  at: Outcome,
  over: Outcome,
  docsFigure: number,
  extra: Record<string, string | number> = {},
): TestResult {
  const holds = accepted(at) && refused(over);
  return {
    id,
    title,
    status: holds ? "pass" : "fail",
    detail: holds
      ? `accepted at ${docsFigure}, refused at ${docsFigure + 1}: "${over.error}"`
      : `docs say ${docsFigure}; at-limit HTTP ${at.status}${at.error ? ` "${at.error}"` : ""}, over-limit HTTP ${over.status}${over.error ? ` "${over.error}"` : ""}`,
    measurements: {
      docs_figure: docsFigure,
      at_limit_status: at.status,
      over_limit_status: over.status,
      over_limit_error: over.error || "none",
      triage_bucket: secretLimitOf(over.error) ?? "unclassified",
      ...extra,
    },
  };
}

const mod: TestModule = {
  id: "EF03",
  title: "Secrets: which of the four limits bites, at the documented boundary",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF03", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    const mine = (n: string) => n.startsWith(PREFIX) || n.startsWith(`SUPABASE_${PREFIX}`);
    try {
      // Stale leftovers from an aborted run would skew the count probe.
      const stale = (await names(ctx)).filter(mine);
      if (stale.length) await remove(ctx, stale);

      // EF03a - reserved prefix.
      const reserved = await post(ctx, [{ name: `SUPABASE_${PREFIX}X`, value: "x" }]);
      const reservedLanded = (await names(ctx)).includes(`SUPABASE_${PREFIX}X`);
      out.push({
        id: "EF03a",
        title: `reserved prefix ${SECRETS.reservedPrefix} is refused`,
        status: refused(reserved) && !reservedLanded ? "pass" : "fail",
        detail: refused(reserved)
          ? `HTTP ${reserved.status}: "${reserved.error}"`
          : `HTTP ${reserved.status} - the reserved prefix was ${reservedLanded ? "ACCEPTED and stored" : "not refused"}`,
        measurements: {
          status: reserved.status,
          error: reserved.error || "none",
          stored: reservedLanded ? 1 : 0,
          triage_bucket: secretLimitOf(reserved.error) ?? "unclassified",
        },
      });

      // EF03b - name length.
      const pad = (n: number, ch: string) => PREFIX + ch.repeat(Math.max(0, n - PREFIX.length));
      const name256 = await post(ctx, [{ name: pad(SECRETS.maxNameChars, "N"), value: "x" }]);
      const name257 = await post(ctx, [{ name: pad(SECRETS.maxNameChars + 1, "M"), value: "x" }]);
      out.push(boundary("EF03b", "name length boundary", name256, name257, SECRETS.maxNameChars));

      // EF03c - value size in one-byte characters.
      const v24576 = await post(ctx, [{ name: `${PREFIX}V_AT`, value: "v".repeat(SECRETS.maxValueChars) }]);
      const v24577 = await post(ctx, [{ name: `${PREFIX}V_OVER`, value: "v".repeat(SECRETS.maxValueChars + 1) }]);
      out.push(boundary("EF03c", "value size boundary (one-byte characters)", v24576, v24577, SECRETS.maxValueChars));

      // EF03c2 - the same character count in THREE-byte characters. Two-byte
      // characters would land on exactly 48 KiB (24,576 x 2), which is why the
      // docs can quote both figures as one; three bytes each puts the same
      // character count at 72 KiB, well over the byte figure, so acceptance
      // means the ceiling counts characters and refusal means it counts bytes.
      const wide = "€".repeat(SECRETS.maxValueChars); // 73,728 bytes UTF-8
      const vWide = await post(ctx, [{ name: `${PREFIX}V_WIDE`, value: wide }]);
      out.push({
        id: "EF03c2",
        title: "value ceiling: characters or bytes?",
        status: "info",
        detail: accepted(vWide)
          ? `${SECRETS.maxValueChars} three-byte characters (${Buffer.byteLength(wide)} bytes, over the ${SECRETS.maxValueBytes}-byte figure) ACCEPTED - the ceiling counts characters; "48 KiB" is ${SECRETS.maxValueChars} at two bytes each`
          : `${SECRETS.maxValueChars} three-byte characters (${Buffer.byteLength(wide)} bytes) refused HTTP ${vWide.status}: "${vWide.error}" - the ceiling counts bytes, not characters`,
        measurements: {
          chars: SECRETS.maxValueChars,
          bytes: Buffer.byteLength(wide),
          docs_bytes: SECRETS.maxValueBytes,
          status: vWide.status,
          error: vWide.error || "none",
        },
      });

      // EF03d - count. Fill to exactly the ceiling, then one more.
      //
      // GET /secrets also lists the platform's own SUPABASE_* entries (URL,
      // keys, DB URL, JWKS - seven of them once the project has had a function
      // deployed) and those do NOT count toward the 100: a run that counted
      // them filled to a listed 100 and had its 101st accepted. Only
      // user-defined secrets count, so only those are counted here.
      const listedBefore = await names(ctx);
      const platform = listedBefore.filter((n) => n.startsWith(SECRETS.reservedPrefix)).length;
      const before = listedBefore.length - platform;
      const toAdd = SECRETS.maxPerProject - before;
      let fillWorst = 0;
      let fillError = "";
      for (let i = 0; i < toAdd; i += 50) {
        const batch = Array.from({ length: Math.min(50, toAdd - i) }, (_, j) => ({
          name: `${PREFIX}C${String(i + j).padStart(3, "0")}`,
          value: "x",
        }));
        const r = await post(ctx, batch);
        fillWorst = Math.max(fillWorst, r.status);
        if (r.error) fillError = r.error;
      }
      const userCount = async () => (await names(ctx)).filter((n) => !n.startsWith(SECRETS.reservedPrefix)).length;
      const atCeiling = await userCount();
      const overCount = await post(ctx, [{ name: `${PREFIX}C_OVER`, value: "x" }]);
      const afterOver = await userCount();
      const holds = atCeiling === SECRETS.maxPerProject && refused(overCount) && afterOver === SECRETS.maxPerProject;
      out.push({
        id: "EF03d",
        title: "count boundary: 100 user-defined secrets per project",
        status: holds ? "pass" : "fail",
        detail: holds
          ? `${atCeiling} user secrets stored (+${platform} platform SUPABASE_* listed, not counted), the ${SECRETS.maxPerProject + 1}st refused HTTP ${overCount.status}: "${overCount.error}"`
          : `filled to ${atCeiling} user secrets (fill worst HTTP ${fillWorst}${fillError ? ` "${fillError}"` : ""}); ${SECRETS.maxPerProject + 1}st -> HTTP ${overCount.status}${overCount.error ? ` "${overCount.error}"` : ""}; ${afterOver} stored afterwards`,
        measurements: {
          docs_figure: SECRETS.maxPerProject,
          preexisting_user: before,
          platform_secrets_listed: platform,
          stored_at_ceiling: atCeiling,
          over_status: overCount.status,
          over_error: overCount.error || "none",
          stored_after_over: afterOver,
          triage_bucket: secretLimitOf(overCount.error) ?? "unclassified",
          docs_read_at: DOCS_READ_AT,
        },
      });
    } catch (e) {
      out.push({ id: "EF03", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      try {
        const left = (await names(ctx)).filter(mine);
        const st = left.length ? await remove(ctx, left) : 0;
        const after = (await names(ctx)).filter(mine);
        out.push({
          id: "EF03z",
          title: "cleanup: remove PVLAB_EF03_ secrets",
          status: after.length === 0 ? "pass" : "fail",
          detail: after.length === 0 ? `removed ${left.length}` : `${after.length} LEFT ON THE PROJECT (delete HTTP ${st})`,
          measurements: { removed: left.length - after.length, left: after.length },
        });
      } catch (e) {
        out.push({ id: "EF03z", title: "cleanup", status: "fail", detail: `cleanup threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return out;
  },
};
export default mod;
