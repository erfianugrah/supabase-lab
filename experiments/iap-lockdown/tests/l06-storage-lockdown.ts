/**
 * L06 - Storage lockdown.
 *
 * The inventory's storage rows (buckets list, public object, render path, S3
 * endpoint) under each lever:
 *
 *   L06a - flip the public bucket private (PUT /storage/v1/bucket/{id}
 *          { public: false } with the service key), re-inventory anon:
 *          public URL should 400/403/404; signed URL (createSignedUrl with
 *          service key) should still serve - signed URLs are the escape
 *          hatch a locked-down customer uses.
 *   L06b - public-read-with-no-list nuance if observable: object URL vs
 *          bucket listing.
 *   L06c - record whether any Management API surface sets a global storage
 *          posture (expected: none - per-bucket only). Absence recorded via
 *          the L09 OpenAPI enumeration, not guessed paths.
 *
 * Note the residency-facts finding that bears on any "private bucket" claim:
 * the CDN caches per token and does not re-evaluate policy on a hit - a
 * cached object stays served to a since-denied user. Lockdown of a
 * previously-public bucket does not purge; record behaviour if observed.
 *
 * DESTRUCTIVE: flips bucket visibility; restores public:true in finally.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types.js";

const mod: TestModule = {
  id: "L06",
  title: "Storage lockdown: private buckets, signed URLs, CDN cache residue",
  where: "local",
  requires: ["pat", "anon-key"],
  destructive: true,
  async run(_ctx: Ctx): Promise<TestResult> {
    return {
      id: "L06",
      title: this.title,
      status: "skip",
      detail: "STUB - see file header. Lever: PUT /storage/v1/bucket/iap-public { public: false } via service key.",
    };
  },
};
export default mod;
