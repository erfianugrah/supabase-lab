/**
 * F05 - is organization membership writable from the stable API?
 *
 * The claim under test: automation gets pushed onto the unstable surface the
 * dashboard uses because membership and provisioning actions are not reachable
 * from the documented API. A sibling gateway project reached the same
 * conclusion from the inside, by watching its own proxy refuse the writes; this
 * asks the published contract directly, which is the stronger evidence of the
 * two because it does not depend on that proxy's routing table being complete.
 *
 * METHOD - and this is the part worth not changing. An earlier investigation on
 * a different question concluded "the API cannot do X" after probing only the
 * endpoints whose path contained X's noun, and was wrong: the lever lived on a
 * differently-named path. So F05 does not guess paths. It reads the published
 * OpenAPI document and enumerates EVERY operation, then filters. A negative
 * result is only worth stating across the complete set.
 *
 * The spec is unauthenticated, so `mgmt()` is not used for it - that helper
 * prefixes the /v1 base and attaches a bearer, and the document sits outside
 * both. F05b goes through `mgmt()` as usual and is what proves the documented
 * read actually answers for this token.
 *
 * Read-only. No project of its own. Runs without --destructive.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const SPEC_URL = "https://api.supabase.com/api/v1-json";
const VERBS = ["get", "post", "put", "patch", "delete"] as const;
const WRITE_VERBS = ["post", "put", "patch", "delete"] as const;

interface Operation {
  verb: string;
  path: string;
}

/** Every (verb, path) pair in the document. */
function operations(spec: Record<string, unknown>): Operation[] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const verb of VERBS) {
      if (item[verb]) out.push({ verb, path });
    }
  }
  return out;
}

async function specSurface(): Promise<TestResult> {
  let spec: Record<string, unknown>;
  try {
    const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      return {
        id: "F05a",
        title: "Membership write surface in the published API",
        status: "fail",
        detail: `spec fetch: HTTP ${res.status}`,
        measurements: { spec_status: res.status },
      };
    }
    spec = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    return {
      id: "F05a",
      title: "Membership write surface in the published API",
      status: "fail",
      detail: `spec fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const ops = operations(spec);

  // CONTROL. A document that parsed but yielded a handful of operations is a
  // fetch that half-worked, and "no member writes" would then be an artifact of
  // the fetch rather than a fact about the platform. The threshold is
  // deliberately far below the observed count - it is a smoke test, not an
  // assertion about how many endpoints should exist.
  if (ops.length < 50) {
    return {
      id: "F05a",
      title: "Membership write surface in the published API",
      status: "fail",
      detail: `only ${ops.length} operations parsed - the document did not arrive intact, so any absence below is meaningless`,
      measurements: { total_operations: ops.length },
    };
  }

  const orgOps = ops.filter((o) => o.path.includes("organizations"));
  const orgWrites = orgOps.filter((o) => (WRITE_VERBS as readonly string[]).includes(o.verb));
  const memberOps = ops.filter((o) => /member/i.test(o.path));
  const memberWrites = memberOps.filter((o) =>
    (WRITE_VERBS as readonly string[]).includes(o.verb),
  );

  // Membership-ADJACENT writes that are a different subsystem. Recorded because
  // a keyword search for "invite" finds them and they are easy to mistake for
  // membership provisioning: they grant temporary DATABASE access, not
  // organization seats.
  const jitInviteOps = ops.filter((o) => /jit\/invite/i.test(o.path));

  const measurements: Record<string, string | number> = {
    total_operations: ops.length,
    org_operations: orgOps.length,
    org_write_operations: orgWrites.length,
    member_operations: memberOps.length,
    member_write_operations: memberWrites.length,
    db_jit_invite_operations: jitInviteOps.length,
    org_writes: orgWrites.map((o) => `${o.verb.toUpperCase()} ${o.path}`).sort().join(" | ") || "none",
    member_ops: memberOps.map((o) => `${o.verb.toUpperCase()} ${o.path}`).sort().join(" | ") || "none",
  };

  return {
    id: "F05a",
    title: "Membership write surface in the published API",
    // `info`, not pass/fail: this records what the platform publishes today.
    // The day a member write appears, `member_write_operations` moves from 0
    // and `pvlab --diff` surfaces it - which is what that mode is for.
    status: "info",
    detail:
      memberWrites.length === 0
        ? `no member write in ${ops.length} operations; membership is read-only on the stable API ` +
          `(${orgWrites.length} org write(s) exist, none of them membership)`
        : `${memberWrites.length} member write operation(s) now exist - the read-only finding has changed`,
    measurements,
  };
}

/** Does the one documented membership read actually answer for this token? */
async function liveRead(ctx: Ctx): Promise<TestResult> {
  if (!ctx.orgSlugs.length) {
    return {
      id: "F05b",
      title: "Documented membership read, live",
      status: "skip",
      detail: "needs PVLAB_ORG_SLUGS",
    };
  }
  const slug = ctx.orgSlugs[0]!;
  const members = await mgmt(ctx, "GET", `/organizations/${slug}/members`);
  const control = await mgmt(ctx, "GET", "/projects");

  const measurements: Record<string, string | number> = {
    members_status: members.status ?? 0,
    control_projects_status: control.status ?? 0,
    members_body: members.throttled ? "throttled" : members.json ? "json" : "non-json",
  };

  if (members.throttled || control.throttled) {
    return {
      id: "F05b",
      title: "Documented membership read, live",
      status: "skip",
      detail: "throttled (HTML interstitial) - re-run",
      measurements,
    };
  }
  if (control.status !== 200) {
    return {
      id: "F05b",
      title: "Documented membership read, live",
      status: "fail",
      detail: "control endpoint did not answer 200 - this run says nothing about membership",
      measurements,
    };
  }

  return {
    id: "F05b",
    title: "Documented membership read, live",
    status: members.status === 200 ? "pass" : "fail",
    detail:
      members.status === 200
        ? "the documented read answers; the absence in F05a is of writes, not of the whole surface"
        : `documented read returned HTTP ${members.status} while the control returned 200`,
    measurements,
  };
}

const mod: TestModule = {
  id: "F05",
  title: "Control-plane membership write surface",
  where: "local",
  requires: ["pat"],
  async run(ctx: Ctx) {
    return [await specSurface(), await liveRead(ctx)];
  },
};
export default mod;
