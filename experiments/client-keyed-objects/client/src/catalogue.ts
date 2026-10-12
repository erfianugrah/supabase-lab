/**
 * The record catalogue through the Data API (PostgREST, schema `app`), always
 * with the user's own token so RLS decides.
 */
import type { Session, TargetConfig } from "./ctx";
import { CkError } from "./errors";

export interface AssetRow {
  id: string;
  record_id: string;
  tenant_id: string;
  object_key: string;
  plaintext_size: number;
  chunk_size: number;
  chunk_count: number;
  ciphertext_size: number;
  cipher: string;
  key_id: string;
  wrapped_dek: string;
  nonce_prefix: string;
  plaintext_sha256: string | null;
  upload_state: string;
  upload_method: string | null;
  s3_upload_id: string | null;
  tus_url: string | null;
}

/**
 * Data API calls retried because PostgREST answered `401 PGRST303 JWT issued
 * at future` to a token Auth had just issued (seen on the self-hosted stack,
 * PostgREST v14.17; compare https://github.com/PostgREST/postgrest/issues/5172).
 * Counted so the suite can report how often the retry fired.
 */
export const restStats = { iatFutureRetries: 0 };

export async function rest<T = unknown>(
  t: TargetConfig,
  s: Session,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  try {
    return await rest1<T>(t, s, method, path, body, extra);
  } catch (e) {
    if (!(e instanceof CkError) || e.detail.code !== "PGRST303" || !/issued at future/i.test(String(e.detail.message))) throw e;
    restStats.iatFutureRetries++;
    await new Promise((r) => setTimeout(r, 2000));
    return rest1<T>(t, s, method, path, body, extra);
  }
}

async function rest1<T = unknown>(
  t: TargetConfig,
  s: Session,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${t.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: t.anonKey,
        authorization: `Bearer ${await s.token()}`,
        "accept-profile": "app",
        "content-profile": "app",
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new CkError("CatalogueError", `data api unreachable: ${(e as Error).message}`);
  }
  const text = await r.text();
  if (r.status >= 300) {
    let code = "";
    let message = "";
    try {
      const j = JSON.parse(text);
      code = String(j.code ?? "");
      message = String(j.message ?? "").slice(0, 120);
    } catch {
      message = text.slice(0, 120);
    }
    throw new CkError("CatalogueError", `${method} ${path.split("?")[0]} answered ${r.status} ${code} ${message}`, { status: r.status, code, message });
  }
  return (text ? JSON.parse(text) : null) as T;
}

export async function getAsset(t: TargetConfig, s: Session, id: string): Promise<AssetRow> {
  const rows = await rest<AssetRow[]>(t, s, "GET", `assets?id=eq.${id}&select=*`);
  if (!rows.length) throw new CkError("CatalogueError", `asset ${id} not visible`, { status: 404 });
  const a = rows[0]!;
  for (const k of ["plaintext_size", "ciphertext_size"] as const) a[k] = Number(a[k]);
  return a;
}

export async function insertAsset(t: TargetConfig, s: Session, row: Partial<AssetRow>): Promise<void> {
  await rest(t, s, "POST", "assets", row, { prefer: "return=minimal" });
}

export async function patchAsset(t: TargetConfig, s: Session, id: string, patch: Partial<AssetRow> & { completed_at?: string }): Promise<void> {
  await rest(t, s, "PATCH", `assets?id=eq.${id}`, patch, { prefer: "return=minimal" });
}

export async function upsertChunks(t: TargetConfig, s: Session, rows: { asset_id: string; idx: number; ciphertext_sha256: string }[]): Promise<void> {
  if (!rows.length) return;
  await rest(t, s, "POST", "asset_chunks?on_conflict=asset_id,idx", rows, { prefer: "return=minimal,resolution=merge-duplicates" });
}

export async function chunkHashes(t: TargetConfig, s: Session, assetId: string, first: number, last: number): Promise<Map<number, string>> {
  const rows = await rest<{ idx: number; ciphertext_sha256: string }[]>(
    t,
    s,
    "GET",
    `asset_chunks?asset_id=eq.${assetId}&idx=gte.${first}&idx=lte.${last}&select=idx,ciphertext_sha256`,
  );
  return new Map(rows.map((r) => [r.idx, r.ciphertext_sha256]));
}

export async function chunkRowCount(t: TargetConfig, s: Session, assetId: string): Promise<number> {
  // Aggregates are off by default in PostgREST (PGRST123); chunk counts stay well under max-rows.
  const rows = await rest<{ idx: number }[]>(t, s, "GET", `asset_chunks?asset_id=eq.${assetId}&select=idx`);
  return rows.length;
}

export async function logAccess(t: TargetConfig, s: Session, row: { action: string; tenant_id: string; asset_id: string; byte_range?: string }): Promise<void> {
  await rest(t, s, "POST", "access_log", { ...row, actor: s.userId }, { prefer: "return=minimal" });
}
