/**
 * Region routing and sessions.
 *
 * A static directory (config, not a database) maps tenant -> home region, and
 * region -> target config. Every call resolves its target from the tenant
 * first; nothing in the client looks at which kind of deployment a target is.
 * A user exists per region (separate Auth per project), so sessions are per
 * region too.
 */
import { CkError } from "./errors";

/** Everything the client knows about one deployment. Only data, no switches. */
export interface TargetConfig {
  /** Label for logs and results; never branched on. */
  name: string;
  region: string;
  /** Gateway base URL: <url>/auth/v1, /rest/v1, /storage/v1. */
  url: string;
  /** Storage base for uploads (the direct storage host where one exists): <storageUrl>/upload/resumable, /s3. */
  storageUrl: string;
  /** Public (anon) API key sent as `apikey`. */
  anonKey: string;
  s3: { endpoint: string; region: string; accessKeyId: string };
  keyServiceUrl: string;
  bucket: string;
}

export interface Directory {
  tenants: Record<string, string>;
  regions: Record<string, TargetConfig>;
}

export function resolveTarget(dir: Directory, tenantId: string): TargetConfig {
  const region = dir.tenants[tenantId];
  const t = region ? dir.regions[region] : undefined;
  if (!t) throw new CkError("UnknownTenant", `tenant ${tenantId} has no home region in the directory`);
  return t;
}

export interface Hasher {
  update(u: Uint8Array): void;
  digestHex(): Promise<string>;
}

/** What differs between Bun and the browser (never between targets). */
export interface Platform {
  sha256Stream(): Hasher;
  md5Hex?(u: Uint8Array): string;
}

export class Session {
  private constructor(
    readonly target: TargetConfig,
    private access: string,
    private refreshToken: string,
    private expMs: number,
    readonly userId: string,
  ) {}

  private static async grant(target: TargetConfig, grant: string, body: unknown) {
    let r: Response | undefined;
    // Network errors (no HTTP answer) are retried: a pooled keep-alive
    // connection the far side had closed failed a refresh mid-upload on the
    // managed run ("The socket connection was closed unexpectedly"). An HTTP
    // answer, including a refusal, is final.
    for (let attempt = 0; ; attempt++) {
      try {
        r = await fetch(`${target.url}/auth/v1/token?grant_type=${grant}`, {
          method: "POST",
          headers: { apikey: target.anonKey, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        break;
      } catch (e) {
        if (attempt >= 3) throw new CkError("AuthError", `auth unreachable: ${(e as Error).message}`);
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, any>;
    if (r.status !== 200 || !j.access_token) throw new CkError("AuthError", `token grant ${grant} answered ${r.status}`, { status: r.status, code: j.error_code ?? j.error ?? "" });
    return j;
  }

  static async signIn(target: TargetConfig, email: string, password: string): Promise<Session> {
    const j = await Session.grant(target, "password", { email, password });
    return new Session(target, j.access_token, j.refresh_token, Number(j.expires_at) * 1000, String(j.user?.id ?? ""));
  }

  private refreshing: Promise<void> | null = null;
  /** Refreshes performed by this session (diagnostics). */
  refreshes = 0;

  /**
   * A token with at least 60 s left; refreshes through Auth when needed.
   * Single-flight: concurrent callers (a ranged read fetches ciphertext and
   * chunk hashes in parallel) share one refresh. Two parallel refreshes with
   * the same refresh token got `400 refresh_token_already_used` from Auth for
   * the second, and every later call then went out with the expired token.
   */
  async token(): Promise<string> {
    if (this.expMs - Date.now() < 60_000) {
      this.refreshing ??= (async () => {
        try {
          const j = await Session.grant(this.target, "refresh_token", { refresh_token: this.refreshToken });
          this.access = j.access_token;
          this.refreshToken = j.refresh_token;
          this.expMs = Number(j.expires_at) * 1000;
          this.refreshes++;
        } finally {
          this.refreshing = null;
        }
      })();
      await this.refreshing;
    }
    return this.access;
  }

  get expiresAtMs(): number {
    return this.expMs;
  }

  claims(): Record<string, unknown> {
    const p = this.access.split(".")[1] ?? "";
    return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
  }
}

export interface Credentials {
  email: string;
  password: string;
}

/** The client: a directory, credentials per region, one platform adapter. */
export class Ck {
  private sessions = new Map<string, Promise<Session>>();
  readonly deks = new Map<string, Uint8Array>();
  constructor(
    readonly dir: Directory,
    private creds: Record<string, Credentials>,
    readonly platform: Platform,
  ) {}

  target(tenantId: string): TargetConfig {
    return resolveTarget(this.dir, tenantId);
  }

  session(t: TargetConfig): Promise<Session> {
    let s = this.sessions.get(t.region);
    if (!s) {
      const c = this.creds[t.region];
      if (!c) throw new CkError("AuthError", `no credentials for region ${t.region}`);
      s = Session.signIn(t, c.email, c.password);
      s.catch(() => this.sessions.delete(t.region));
      this.sessions.set(t.region, s);
    }
    return s;
  }
}
