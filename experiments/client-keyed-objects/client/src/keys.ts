/**
 * Key service calls. The DEK is wrapped and unwrapped only by the operator's
 * key service; Supabase stores the wrapped form. Unreachable -> fail closed
 * with KeyServiceUnavailable; nothing is uploaded or decrypted without a DEK.
 */
import type { Ck, Session, TargetConfig } from "./ctx";
import { b64, unb64 } from "./envelope";
import { CkError } from "./errors";

async function call(t: TargetConfig, s: Session, path: string, body: unknown): Promise<Record<string, string>> {
  let r: Response;
  try {
    r = await fetch(`${t.keyServiceUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${await s.token()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CkError("KeyServiceUnavailable", `key service unreachable: ${(e as Error).message}`);
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, string>;
  if (r.status === 200) return j;
  if (r.status >= 500 && r.status !== 502) throw new CkError("KeyServiceUnavailable", `key service answered ${r.status}`, { status: r.status, error: j.error });
  if (r.status === 401 || r.status === 403) throw new CkError("KeyServiceDenied", `key service refused: ${j.error}`, { status: r.status, error: j.error });
  throw new CkError("KeyServiceError", `key service answered ${r.status} ${j.error}`, { status: r.status, error: j.error });
}

export async function wrapDek(t: TargetConfig, s: Session, tenantId: string, dek: Uint8Array): Promise<{ wrapped: string; key_id: string }> {
  const j = await call(t, s, "/wrap", { tenant_id: tenantId, dek: b64(dek) });
  return { wrapped: j.wrapped!, key_id: j.key_id! };
}

/** Unwrap, cached per asset for the life of the process (a fresh process always asks). */
export async function unwrapDek(ck: Ck, t: TargetConfig, s: Session, tenantId: string, assetId: string, wrapped: string): Promise<Uint8Array> {
  const hit = ck.deks.get(assetId);
  if (hit) return hit;
  const j = await call(t, s, "/unwrap", { tenant_id: tenantId, wrapped });
  const dek = unb64(j.dek!);
  ck.deks.set(assetId, dek);
  return dek;
}
