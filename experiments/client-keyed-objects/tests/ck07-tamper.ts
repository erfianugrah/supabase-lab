/**
 * CK07 - Does every read of tampered ciphertext fail closed with a typed
 * error, on every target?
 *
 * SIDE: each target. A 64 MiB asset is uploaded by the editor (S3 multipart);
 * the stored object is first copied aside (S3 CopyObject), then overwritten
 * through the S3 endpoint with service-level credentials (the stack's S3
 * protocol keys, or the session-token form with service_role on managed),
 * read back by the viewer through S3 GetObject, and restored from the copy
 * before the next variant.
 *
 *   flip      one bit flipped inside chunk 2
 *   swap      chunks 0 and 1 exchanged (same lengths, so the object size holds)
 *   truncate  the object cut 100 bytes into the second-to-last chunk
 *   control   after restoring from the copy, the same reads succeed
 *
 * Each variant is read twice: with the catalogue hash check (expected
 * ChunkHashMismatch, or TruncatedObject) and with the hash check off, so the
 * AES-GCM layer alone is shown to refuse too (expected ChunkAuthFailed or
 * TruncatedObject).
 *
 * Not settled: tampering of the catalogue itself (an editor rewriting chunk
 * hashes is inside the trust boundary of this design).
 * DESTRUCTIVE: writes and overwrites objects in the run's own bucket.
 */
import type { Ctx, TestModule, TestResult } from "../../../harness/src/types";
import { credsFor, directory, errMsg, loadRun, loadState, row, runClient, s3svc, saveState, scrub, type HarnessTarget, type Loaded } from "../lib/ckrun";

const CHUNK = 8 * 1024 * 1024;
const STRIDE = CHUNK + 16;

async function read(l: Loaded, t: HarnessTarget, tenant: string, asset: string, chunk: number, verifyHashes: boolean, path = "s3"): Promise<string> {
  const r = await runClient({
    cmd: "read-one",
    directory: directory(l),
    creds: credsFor(l, "viewer"),
    tenant,
    asset,
    start: chunk * CHUNK + 10,
    end: chunk * CHUNK + 1010,
    path,
    verifyHashes,
    file: l.run.fixtures.mid.path,
  });
  return r.result.ok ? (r.result.equal ? "ok" : "WRONG-BYTES") : String(r.result.code);
}

const mod: TestModule = {
  id: "CK07",
  title: "Tampered ciphertext fails closed",
  where: "local",
  destructive: true,
  async run(ctx: Ctx): Promise<TestResult[]> {
    const l = loadRun(ctx);
    if ("skip" in l) return [{ id: "CK07", title: this.title, status: "skip", detail: l.skip }];
    const out: TestResult[] = [];
    for (const t of l.targets) {
      const st = loadState(l.run, t.name);
      const m: Record<string, string | number> = {};
      try {
        const up = await runClient({ cmd: "upload", directory: directory(l), creds: credsFor(l, "editor"), tenant: st.tenants.primary, record: st.records.primary, file: l.run.fixtures.mid.path, method: "s3-multipart" });
        if (!up.result.ok) throw new Error(`upload: ${up.result.code} ${up.result.message}`);
        const asset = String(up.result.assetId);
        const key = String(up.result.objectKey);
        const size = Number(up.result.ciphertextSize);
        const chunks = Math.ceil(size / STRIDE);
        st.assets.mid = { id: asset, tenant: st.tenants.primary, method: "s3-multipart", size: l.run.fixtures.mid.size };
        saveState(l.run, t.name, st);
        const backup = `${st.tenants.primary}/${asset}/backup`;
        const svc = (ops: Record<string, unknown>[]) => runClient({ cmd: "s3ops", s3: s3svc(t), bucket: t.client.bucket, ops });
        const cp = await svc([{ op: "copy", key: backup, from: key }]);
        m.copy_aside = cp.result.results?.[0]?.ok ? "ok" : `${cp.result.results?.[0]?.code ?? cp.result.code}`;
        const restore = () => svc([{ op: "copy", key, from: backup }]);
        const variants: { name: string; op: Record<string, unknown>; chunk: number; want: [string, string] }[] = [
          { name: "flip", op: { op: "tamper", key, mode: "flip", at: 2 * STRIDE + 100 }, chunk: 2, want: ["ChunkHashMismatch", "ChunkAuthFailed"] },
          { name: "swap", op: { op: "tamper", key, mode: "swap", stride: STRIDE }, chunk: 0, want: ["ChunkHashMismatch", "ChunkAuthFailed"] },
          { name: "truncate", op: { op: "tamper", key, mode: "truncate", length: (chunks - 2) * STRIDE + 100 }, chunk: chunks - 2, want: ["TruncatedObject", "TruncatedObject"] },
        ];
        const wrong: string[] = [];
        for (const v of variants) {
          const tp = await svc([v.op]);
          const tr = tp.result.results?.[0];
          m[`${v.name}.overwrite`] = tr?.ok ? `ok ${tr.bytes}` : `${tr?.status} ${tr?.code ?? tp.result.code}`;
          const withHash = await read(l, t, st.tenants.primary, asset, v.chunk, true);
          const aeadOnly = await read(l, t, st.tenants.primary, asset, v.chunk, false);
          m[`${v.name}.read_with_hashes`] = withHash;
          m[`${v.name}.read_aead_only`] = aeadOnly;
          if (v.name === "flip") m["flip.read_authenticated_path"] = await read(l, t, st.tenants.primary, asset, v.chunk, true, "authenticated");
          if (withHash !== v.want[0] || aeadOnly !== v.want[1]) wrong.push(`${v.name}: ${withHash}/${aeadOnly}`);
          const rs = await restore();
          m[`${v.name}.restore`] = rs.result.results?.[0]?.ok ? "ok" : `${rs.result.results?.[0]?.code}`;
        }
        m["control.read_after_restore"] = await read(l, t, st.tenants.primary, asset, 2, true);
        if (m["control.read_after_restore"] !== "ok") wrong.push(`control: ${m["control.read_after_restore"]}`);
        out.push(row("CK07", t, this.title, wrong.length ? "fail" : "pass", wrong.length ? `unexpected: ${wrong.join("; ")}` : "flip, swap and truncate each refused by both layers; restored copy reads clean", m));
      } catch (e) {
        out.push(row("CK07", t, this.title, "fail", `threw: ${scrub(l, errMsg(e))}`, m));
      }
    }
    return out;
  },
};
export default mod;
