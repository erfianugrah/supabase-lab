/**
 * EF11 - the metadata races, repeated until they mean something.
 *
 * EF05 ran one delete-during-deploy trial and three rounds of two concurrent
 * same-slug deploys, and both came out clean. One clean trial against a path
 * reported to corrupt function metadata proves nothing, so this module
 * repeats each shape enough times to say whether corruption appears at this
 * scale, and records the signature if it does: a function GET says present
 * while the invocation 404s, a version that moves backwards, or a deploy that
 * reports 201 and leaves nothing behind.
 *
 *   EF11a  delete during deploy, 10 rounds, delete fired 0-400 ms into the
 *          deploy; after each: GET, invoke, then a fresh deploy of the same
 *          slug to see whether the slug recovers
 *   EF11b  same slug, 4 concurrent deploys, 5 rounds; version sequence,
 *          status histogram, invoke after each round
 *
 * DESTRUCTIVE: deploys under pvlab-ef11-, deletes in finally.
 */
import { mgmt } from "../../../harness/src/mgmt";
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { cleanupPrefix, deployViaApi, invoke, landedPatiently, tinySource } from "../lib/ef";

const P = "pvlab-ef11-";
const DELETE_ROUNDS = 10;
const RACE_ROUNDS = 5;
const RACE_WIDTH = 4;

const meta = (slug: string) => ({ entrypoint_path: "index.ts", name: slug, verify_jwt: false });

function histogram(values: (number | string)[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, n]) => `${k}:${n}`).join("|") || "none";
}

/** Invoke with a short retry through 404 (propagation) so a real 404 is a settled one. */
async function settledInvoke(ctx: Ctx, slug: string): Promise<number> {
  let last = 0;
  for (let i = 0; i < 6; i++) {
    last = (await invoke(ctx, slug, { timeoutMs: 20_000 })).status;
    if (last !== 404 && last !== 0) return last;
    await Bun.sleep(5_000);
  }
  return last;
}

const mod: TestModule = {
  id: "EF11",
  title: "Metadata races repeated: delete during deploy x10, same-slug 4-wide x5",
  where: "local",
  requires: ["pat"],
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    if (!ctx.ref) return [{ id: "EF11", title: this.title, status: "skip", detail: "no project ref (PVLAB_REF)" }];
    const out: TestResult[] = [];
    try {
      await cleanupPrefix(ctx, P);

      // ---- EF11a: delete during deploy ----
      const outcomes: string[] = [];
      const deployStatuses: number[] = [];
      const deleteStatuses: number[] = [];
      const recover: number[] = [];
      let broken = 0;
      for (let r = 0; r < DELETE_ROUNDS; r++) {
        const slug = `${P}del-${r}`;
        await deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(`seed-${r}`) }], meta(slug));
        await landedPatiently(ctx, slug);
        const offset = Math.floor(Math.random() * 400);
        const [dep, del] = await Promise.all([
          deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(`race-${r}`) }], meta(slug)),
          (async () => {
            await Bun.sleep(offset);
            return mgmt(ctx, "DELETE", `/projects/${ctx.ref}/functions/${slug}`);
          })(),
        ]);
        deployStatuses.push(dep.status);
        deleteStatuses.push(del.status);
        const l = await landedPatiently(ctx, slug);
        const inv = l.present ? await settledInvoke(ctx, slug) : -1;
        let outcome: string;
        if (l.present && inv === 200) outcome = "present-healthy";
        else if (l.present && inv !== 200) {
          outcome = `present-but-invoke-${inv}`;
          broken++;
        } else if (!l.present && dep.status < 300 && del.status < 300) outcome = "absent-delete-won";
        else outcome = `absent-dep${dep.status}-del${del.status}`;
        // Can the slug be redeployed afterwards?
        const redo = await deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(`redo-${r}`) }], meta(slug));
        const redoInv = redo.status < 300 ? await settledInvoke(ctx, slug) : redo.status;
        recover.push(redoInv);
        if (redo.status < 300 && redoInv !== 200) broken++;
        outcomes.push(`${outcome}@${offset}ms->redeploy ${redoInv}`);
      }
      out.push({
        id: "EF11a",
        title: `delete during deploy, ${DELETE_ROUNDS} rounds`,
        status: broken === 0 ? "pass" : "fail",
        detail:
          `${broken} corrupted outcome(s) in ${DELETE_ROUNDS} rounds; deploy ${histogram(deployStatuses)}, delete ${histogram(deleteStatuses)}; ` +
          `outcomes ${histogram(outcomes.map((o) => o.split("@")[0] ?? o))}; redeploy afterwards ${histogram(recover)}` +
          (broken === 0 ? " - no corruption signature at this scale (still not proof of absence)" : ""),
        measurements: {
          rounds: DELETE_ROUNDS,
          corrupted: broken,
          deploy_histogram: histogram(deployStatuses),
          delete_histogram: histogram(deleteStatuses),
          outcome_histogram: histogram(outcomes.map((o) => o.split("@")[0] ?? o)),
          redeploy_invoke_histogram: histogram(recover),
        },
        evidence: outcomes.join("\n"),
      });

      // ---- EF11b: same slug, 4-wide ----
      const slug = `${P}race`;
      const seed = await deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource("v0") }], meta(slug));
      const versions: (number | string)[] = [seed.version ?? (await landedPatiently(ctx, slug)).version ?? "?"];
      const statuses: number[] = [];
      const invokes: number[] = [];
      let regressed = 0;
      for (let round = 1; round <= RACE_ROUNDS; round++) {
        const results = await Promise.all(
          Array.from({ length: RACE_WIDTH }, (_, k) => deployViaApi(ctx, slug, [{ name: "index.ts", content: tinySource(`r${round}-${k}`) }], meta(slug))),
        );
        statuses.push(...results.map((x) => x.status));
        const now = (await landedPatiently(ctx, slug)).version ?? "?";
        const prev = versions[versions.length - 1];
        if (typeof now === "number" && typeof prev === "number" && now < prev) regressed++;
        versions.push(now);
        invokes.push(await settledInvoke(ctx, slug));
      }
      const unhealthy = invokes.filter((s) => s !== 200).length;
      out.push({
        id: "EF11b",
        title: `same slug, ${RACE_WIDTH} concurrent deploys, ${RACE_ROUNDS} rounds`,
        status: regressed === 0 && unhealthy === 0 ? "pass" : "fail",
        detail: `versions ${versions.join(" -> ")}; ${regressed} regression(s); statuses ${histogram(statuses)}; invoke after each round ${histogram(invokes)}`,
        measurements: {
          rounds: RACE_ROUNDS,
          width: RACE_WIDTH,
          versions: versions.join(">"),
          version_regressions: regressed,
          status_histogram: histogram(statuses),
          n_201: statuses.filter((s) => s === 201).length,
          n_409: statuses.filter((s) => s === 409).length,
          n_429: statuses.filter((s) => s === 429).length,
          invoke_histogram: histogram(invokes),
        },
      });
    } catch (e) {
      out.push({ id: "EF11", title: this.title, status: "fail", detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      const c = await cleanupPrefix(ctx, P).catch((e) => ({ deleted: 0, left: [`cleanup threw: ${e instanceof Error ? e.message : String(e)}`] }));
      out.push({ id: "EF11z", title: "cleanup: delete pvlab-ef11-* functions", status: c.left.length ? "fail" : "pass", detail: c.left.length ? `LEFT DEPLOYED: ${c.left.join(", ")}` : `deleted ${c.deleted}`, measurements: { deleted: c.deleted, left: c.left.length } });
    }
    return out;
  },
};
export default mod;
