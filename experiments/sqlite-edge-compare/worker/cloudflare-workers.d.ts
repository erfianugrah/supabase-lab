/**
 * Minimal ambient types for the parts of `cloudflare:workers` the probe Worker
 * uses (no @cloudflare/workers-types dependency in this repo).
 */
declare module "cloudflare:workers" {
  export interface SqlCursor {
    toArray(): Record<string, unknown>[];
    readonly rowsRead: number;
    readonly rowsWritten: number;
  }
  export interface DurableObjectStateLike {
    storage: {
      sql: { exec(query: string, ...bindings: unknown[]): SqlCursor; readonly databaseSize: number };
      transactionSync<T>(fn: () => T): T;
      deleteAll(): Promise<void>;
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectStateLike;
    protected env: Env;
    constructor(ctx: DurableObjectStateLike, env: Env);
  }
}
