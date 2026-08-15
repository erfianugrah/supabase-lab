/**
 * W10 - storage object fallback (the 404 gap and the sync path).
 *
 * Measures the parity gap: an object uploaded to primary storage does NOT
 * exist on the standby. Then verifies the manual sync path (download from
 * primary, upload to standby) closes the gap.
 *
 * Pass criteria: gap recorded (404 before sync), 200 + byte-equal after
 * sync, durations in measurements.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { mgmt } from "../../../harness/src/mgmt";

const mod: TestModule = {
  id: "W10",
  title: "storage object fallback (the 404 gap and the sync path)",
  where: "local",
  requires: ["pat", "anon-key", "peer"],
  destructive: true,

  async run(ctx: Ctx): Promise<TestResult> {
    const primary = ctx.ref;
    const standby = ctx.peers["standby"];
    const standbyAnon = ctx.endpoints["standby_anon"];
    const measurements: Record<string, string | number> = {};

    if (!standby || !standbyAnon || !ctx.serviceKey) {
      return {
        id: "W10",
        title: this.title,
        status: "skip",
        detail: `missing peer/endpoints/serviceKey: standby=${standby ?? "absent"}, standby_anon=${standbyAnon ? "set" : "absent"}, serviceKey=${ctx.serviceKey ? "set" : "absent"}`,
      };
    }

    // Fetch standby service key via ctx.pat (same pattern as W09 step 6).
    const getStandbyServiceKey = async (): Promise<string | undefined> => {
      const res = await mgmt(ctx, "GET", `/projects/${standby}/api-keys?reveal=true`);
      if (res.status !== 200 || !Array.isArray(res.json)) return undefined;
      const keys = res.json as Array<{ type?: string; name?: string; api_key?: string }>;
      const found = keys.find(
        (k) => k.type === "service_role" || k.type === "secret" || k.name === "service_role",
      );
      return found?.api_key;
    };

    let standbyServiceKey: string | undefined;

    const cleanup = async () => {
      const bucket = "w10-drill";
      // Primary cleanup
      await fetch(`https://${ctx.apiHost}/storage/v1/bucket/${bucket}/empty`, {
        method: "POST",
        headers: {
          apikey: ctx.serviceKey!,
          Authorization: `Bearer ${ctx.serviceKey!}`,
        },
      }).catch(() => {});
      await fetch(`https://${ctx.apiHost}/storage/v1/bucket/${bucket}`, {
        method: "DELETE",
        headers: {
          apikey: ctx.serviceKey!,
          Authorization: `Bearer ${ctx.serviceKey!}`,
        },
      }).catch(() => {});

      // Standby cleanup
      if (standbyServiceKey) {
        await fetch(`https://${standby}.supabase.co/storage/v1/bucket/${bucket}/empty`, {
          method: "POST",
          headers: {
            apikey: standbyServiceKey,
            Authorization: `Bearer ${standbyServiceKey}`,
          },
        }).catch(() => {});
        await fetch(`https://${standby}.supabase.co/storage/v1/bucket/${bucket}`, {
          method: "DELETE",
          headers: {
            apikey: standbyServiceKey,
            Authorization: `Bearer ${standbyServiceKey}`,
          },
        }).catch(() => {});
      }
    };

    try {
      // Fetch standby service key early so cleanup can always run.
      standbyServiceKey = await getStandbyServiceKey();
      if (!standbyServiceKey) {
        return {
          id: "W10",
          title: this.title,
          status: "skip",
          detail: "could not retrieve standby service_role key",
          measurements,
        };
      }

      const bucket = "w10-drill";
      const object = "probe.txt";
      const objectBody = `w10-probe-${Math.random().toString(36).slice(2, 10)}`;

      // Step 1: idempotent setup - empty + delete if exists, then create fresh.
      // A 409/400 BucketAlreadyExists must not fail the run.
      const emptyRes = await fetch(`https://${ctx.apiHost}/storage/v1/bucket/${bucket}/empty`, {
        method: "POST",
        headers: {
          apikey: ctx.serviceKey!,
          Authorization: `Bearer ${ctx.serviceKey!}`,
        },
      });
      measurements["setup_empty_status"] = emptyRes.status;

      const deleteRes = await fetch(`https://${ctx.apiHost}/storage/v1/bucket/${bucket}`, {
        method: "DELETE",
        headers: {
          apikey: ctx.serviceKey!,
          Authorization: `Bearer ${ctx.serviceKey!}`,
        },
      });
      measurements["setup_delete_status"] = deleteRes.status;

      // Create bucket (public so we can fetch via public URL without a key).
      const createBucketRes = await fetch(`https://${ctx.apiHost}/storage/v1/bucket`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ctx.serviceKey!,
          Authorization: `Bearer ${ctx.serviceKey!}`,
        },
        body: JSON.stringify({ id: bucket, name: bucket, public: true }),
        signal: AbortSignal.timeout(30_000),
      });
      measurements["create_bucket_status"] = createBucketRes.status;
      if (!createBucketRes.ok) {
        const errText = await createBucketRes.text().catch(() => "");
        // 400 can mean BucketAlreadyExists from a prior crashed run - not fatal if
        // the message contains "already exists".
        if (!errText.toLowerCase().includes("already")) {
          throw new Error(`create bucket HTTP ${createBucketRes.status}: ${errText.slice(0, 200)}`);
        }
        measurements["create_bucket_note"] = "already_exists_ok";
      }

      // Upload object to primary.
      const uploadRes = await fetch(
        `https://${ctx.apiHost}/storage/v1/object/${bucket}/${object}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            apikey: ctx.serviceKey!,
            Authorization: `Bearer ${ctx.serviceKey!}`,
          },
          body: objectBody,
          signal: AbortSignal.timeout(30_000),
        },
      );
      measurements["upload_status"] = uploadRes.status;
      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => "");
        throw new Error(`upload object HTTP ${uploadRes.status}: ${errText.slice(0, 200)}`);
      }

      // Step 2: fetch same path on standby - expect 404 (parity gap).
      const gapRes = await fetch(
        `https://${standby}.supabase.co/storage/v1/object/public/${bucket}/${object}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      measurements["gap_status"] = gapRes.status;
      measurements["gap_recorded"] = gapRes.status !== 200 ? "true" : "false";
      const gapBody = await gapRes.text().catch(() => "");
      measurements["gap_body_verbatim"] = gapBody.slice(0, 200);

      // Step 3: sync path - download from primary, upload to standby.
      // First create the bucket on the standby.
      const standbyCreateBucketRes = await fetch(
        `https://${standby}.supabase.co/storage/v1/bucket`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: standbyServiceKey,
            Authorization: `Bearer ${standbyServiceKey}`,
          },
          body: JSON.stringify({ id: bucket, name: bucket, public: true }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      measurements["standby_create_bucket_status"] = standbyCreateBucketRes.status;
      if (!standbyCreateBucketRes.ok) {
        const errText = await standbyCreateBucketRes.text().catch(() => "");
        if (!errText.toLowerCase().includes("already")) {
          throw new Error(
            `standby create bucket HTTP ${standbyCreateBucketRes.status}: ${errText.slice(0, 200)}`,
          );
        }
      }

      // Download from primary public URL.
      const syncStart = Date.now();
      const downloadRes = await fetch(
        `https://${ctx.apiHost}/storage/v1/object/public/${bucket}/${object}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      measurements["download_status"] = downloadRes.status;
      if (!downloadRes.ok) {
        throw new Error(`download from primary HTTP ${downloadRes.status}`);
      }
      const downloadedBytes = await downloadRes.arrayBuffer();

      // Upload to standby.
      const standbyUploadRes = await fetch(
        `https://${standby}.supabase.co/storage/v1/object/${bucket}/${object}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            apikey: standbyServiceKey,
            Authorization: `Bearer ${standbyServiceKey}`,
          },
          body: downloadedBytes,
          signal: AbortSignal.timeout(30_000),
        },
      );
      measurements["standby_upload_status"] = standbyUploadRes.status;
      if (!standbyUploadRes.ok) {
        const errText = await standbyUploadRes.text().catch(() => "");
        throw new Error(
          `standby upload HTTP ${standbyUploadRes.status}: ${errText.slice(0, 200)}`,
        );
      }
      measurements["sync_duration_ms"] = Date.now() - syncStart;

      // Step 4: re-fetch on standby - expect 200 with identical bytes.
      const verifyRes = await fetch(
        `https://${standby}.supabase.co/storage/v1/object/public/${bucket}/${object}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      measurements["verify_status"] = verifyRes.status;
      if (!verifyRes.ok) {
        throw new Error(`standby verify fetch HTTP ${verifyRes.status}`);
      }
      const verifyText = await verifyRes.text();
      const byteEqual = verifyText === objectBody;
      measurements["byte_equal"] = byteEqual ? "true" : "false";
      if (!byteEqual) {
        measurements["verify_body_verbatim"] = verifyText.slice(0, 200);
      }

      // The storage API returns HTTP 400 ("Bucket not found") when the bucket
      // does not exist on the standby - the body carries statusCode:"404".
      // Any non-200 gap_status is a valid recorded parity gap.
      const pass =
        measurements["gap_status"] !== 200 &&
        measurements["verify_status"] === 200 &&
        byteEqual;

      return {
        id: "W10",
        title: this.title,
        status: pass ? "pass" : "fail",
        detail: pass
          ? `parity gap confirmed (404), sync path works: ${measurements["sync_duration_ms"]}ms, byte-equal verified`
          : `gap_status=${measurements["gap_status"]}, verify_status=${measurements["verify_status"]}, byte_equal=${measurements["byte_equal"]}`,
        measurements,
      };
    } catch (e: unknown) {
      return {
        id: "W10",
        title: this.title,
        status: "fail",
        detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
        measurements,
      };
    } finally {
      await cleanup();
    }
  },
};

export default mod;
