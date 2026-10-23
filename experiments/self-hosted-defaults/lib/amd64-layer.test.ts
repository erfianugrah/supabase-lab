import { expect, test } from "bun:test";
import { amd64Digest, byDigest } from "./amd64-layer";

test("amd64Digest picks the linux/amd64 entry of an index and ignores attestations", () => {
  const idx = {
    manifests: [
      { digest: "sha256:arm", platform: { architecture: "arm64", os: "linux" } },
      { digest: "sha256:att", platform: { architecture: "unknown", os: "unknown" } },
      { digest: "sha256:amd", platform: { architecture: "amd64", os: "linux" } },
    ],
  };
  expect(amd64Digest(idx)).toBe("sha256:amd");
  expect(amd64Digest({ manifests: [{ digest: "sha256:arm", platform: { architecture: "arm64", os: "linux" } }] })).toBeNull();
  expect(amd64Digest({})).toBeNull();
});

test("byDigest swaps a tag for the digest and keeps registry ports", () => {
  expect(byDigest("supabase/postgres:17.6.1.136", "sha256:x")).toBe("supabase/postgres@sha256:x");
  expect(byDigest("envoyproxy/envoy", "sha256:x")).toBe("envoyproxy/envoy@sha256:x");
  expect(byDigest("localhost:5000/a/b:t", "sha256:x")).toBe("localhost:5000/a/b@sha256:x");
  expect(byDigest("a/b@sha256:old", "sha256:x")).toBe("a/b@sha256:x");
});
