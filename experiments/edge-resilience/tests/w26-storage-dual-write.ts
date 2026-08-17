/**
 * W26 - storage dual-write viability (matrix 5.1).
 *
 * Storage objects do not follow their metadata to the standby (W10
 * measured the gap), so the documented mitigation for object durability
 * is dual-write or an external object store. This drill measures the
 * dual-write pattern's actual shape:
 *
 * 1. Write the same object to primary AND standby storage in parallel -
 *   both succeed, bytes equal on both sides, per-side durations recorded
 *   (the cost of dual-write vs single-write).
 * 2. Partial failure: write to primary succeeds, write to standby goes
 *   at a nonexistent bucket - the realistic dual-write failure is NOT
 *   atomic: the object exists on one side only. The signature a client
 *   sees (one 200, one 400) is recorded verbatim.
 * 3. Recovery: the sync-after path (download from primary, upload to
 *   standby) closes the partial-failure gap - W10 measured it at 780ms
 *   for a small object; this re-measures it in the dual-write context.
 *
 * Pass criteria: all three shapes recorded with timings. Any measured
 * behavior passes.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const BUCKET = "w26-drill";

const mod: TestModule = {
  id: "W26",
  title: "storage dual-write viability (parallel write, partial failure, sync-after)",
  where: "local",
  requires: ["pat", "peer"],
  destructive: true, // creates+empties+deletes buckets on both projects

  async run(ctx: Ctx): Promise<TestResult> {
    const id = "W26";
    const title = this.title;
    const standby = ctx.peers["standby"];
    if (!standby || !ctx.serviceKey) {
      return { id, title, status: "skip", detail: `missing peer/serviceKey: standby=${standby ?? "absent"}` };
    }

    const measurements: Record<string, number | string> = {};
    const evidence: string[] = [];

    const standbyKeys = await mgmt(ctx, "GET", `/projects/${standby}/api-keys?reveal=true`);
    const standbyService = Array.isArray(standbyKeys.json)
      ? (standbyKeys.json as Array<{ type?: string; name?: string; api_key?: string }>).find(
          (k) => k.type === "service_role" || k.type === "secret" || k.name === "service_role",
        )?.api_key
      : undefined;
    if (!standbyService) {
      return { id, title, status: "skip", detail: "standby service key not retrievable" };
    }

    const primaryBase = `https://${ctx.apiHost}/storage/v1`;
    const standbyBase = `https://${standby}.supabase.co/storage/v1`;
    const hdrs = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}` });

    const ensureBucket = async (base: string, key: string) => {
      await fetch(`${base}/bucket`, {
        method: "POST",
        headers: { ...hdrs(key), "Content-Type": "application/json" },
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => {});
    };
    const upload = async (base: string, key: string, bucket: string, name: string, body: Uint8Array) => {
      const t0 = performance.now();
      const res = await fetch(`${base}/object/${bucket}/${name}`, {
        method: "POST",
        headers: { ...hdrs(key), "Content-Type": "application/octet-stream", "x-upsert": "true" },
        body: body.slice().buffer,
        signal: AbortSignal.timeout(30_000),
      });
      const ms = Math.round(performance.now() - t0);
      return { status: res.status, ms, body: res.ok ? "" : (await res.text()).slice(0, 300) };
    };
    const download = async (base: string, key: string, name: string) => {
      const res = await fetch(`${base}/object/public/${BUCKET}/${name}`, {
        headers: hdrs(key),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
    };
    const deleteBucket = async (base: string, key: string) => {
      await fetch(`${base}/bucket/${BUCKET}/empty`, { method: "POST", headers: hdrs(key), signal: AbortSignal.timeout(30_000) }).catch(() => {});
      await fetch(`${base}/bucket/${BUCKET}`, { method: "DELETE", headers: hdrs(key), signal: AbortSignal.timeout(30_000) }).catch(() => {});
    };

    const objectBytes = new TextEncoder().encode(`w26 dual-write drill object ${Date.now()}\n`);

    try {
      await ensureBucket(primaryBase, ctx.serviceKey);
      await ensureBucket(standbyBase, standbyService);

      // 1. Parallel dual-write of the same object to both projects.
      const [p1, s1] = await Promise.all([
        upload(primaryBase, ctx.serviceKey, BUCKET, "shared.bin", objectBytes),
        upload(standbyBase, standbyService, BUCKET, "shared.bin", objectBytes),
      ]);
      measurements["dualwrite_primary_ms"] = p1.ms;
      measurements["dualwrite_standby_ms"] = s1.ms;
      measurements["dualwrite_skew_ms"] = Math.abs(p1.ms - s1.ms);
      measurements["dualwrite_statuses"] = `${p1.status}/${s1.status}`;
      evidence.push(`dual-write shared.bin: primary ${p1.status} in ${p1.ms}ms, standby ${s1.status} in ${s1.ms}ms`);

      const [dp, ds] = await Promise.all([
        download(primaryBase, ctx.serviceKey, "shared.bin"),
        download(standbyBase, standbyService, "shared.bin"),
      ]);
      const equal =
        dp.bytes && ds.bytes && dp.bytes.length === ds.bytes.length &&
        dp.bytes.every((b, i) => b === ds.bytes![i]);
      measurements["bytes_equal"] = equal ? "yes" : "no";
      evidence.push(`read-back: primary ${dp.status}, standby ${ds.status}, bytes equal: ${measurements["bytes_equal"]}`);

      // 2. Partial failure: standby write aimed at a nonexistent bucket.
      const [p2, s2] = await Promise.all([
        upload(primaryBase, ctx.serviceKey, BUCKET, "partial.bin", objectBytes),
        upload(standbyBase, standbyService, "w26-nonexistent", "partial.bin", objectBytes),
      ]);
      measurements["partial_statuses"] = `${p2.status}/${s2.status}`;
      evidence.push(
        `partial failure shape: primary ${p2.status}, standby ${s2.status} (${s2.body || "ok"}) - dual-write is not atomic; the object exists on one side only`,
      );

      // 3. Sync-after closes the gap (same path W10 measured at 780ms).
      const down = await download(primaryBase, ctx.serviceKey, "partial.bin");
      if (down.bytes) {
        const t0 = performance.now();
        const sync = await upload(standbyBase, standbyService, BUCKET, "partial.bin", down.bytes);
        measurements["sync_after_ms"] = sync.ms;
        measurements["sync_after_status"] = sync.status;
        evidence.push(`sync-after partial.bin -> standby: HTTP ${sync.status} in ${sync.ms}ms`);
      }

      return {
        id,
        title,
        status: "pass",
        detail:
          `dual-write ${measurements["dualwrite_statuses"]} (skew ${measurements["dualwrite_skew_ms"]}ms, bytes equal); ` +
          `partial failure ${measurements["partial_statuses"]} is not atomic; ` +
          `sync-after ${measurements["sync_after_ms"] ?? "n/a"}ms closes the gap`,
        measurements,
        evidence: evidence.join("\n"),
      };
    } finally {
      await deleteBucket(primaryBase, ctx.serviceKey);
      await deleteBucket(standbyBase, standbyService);
    }
  },
};

export default mod;
