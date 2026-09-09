/**
 * Every Management API operation NOT covered by the parameter-free GET sweep,
 * in dependency order.
 *
 * Ordered by tier rather than alphabetically, because the parameterised routes
 * cannot be called until something has created the id they take. `capture`
 * lifts an id out of a response; a later op referencing `{TOKEN}` that was
 * never captured SKIPS with a reason instead of being sent with the literal
 * placeholder - a 404 from a bogus path parameter would otherwise read as a
 * finding about the endpoint.
 *
 * `terminal: true` marks operations that end the project or cost real money on
 * a production control plane (upgrade, disk resize, addon apply, project
 * delete). They are gated separately so this list stays safe to point at a
 * staging org without also being a bill.
 */
export interface WriteOp {
  tier: number;
  verb: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `{REF}` and `{ORG}` are substituted; `{UPPER}` names come from captures. */
  path: string;
  body?: unknown;
  /** [captureName, dotted path into the JSON response] */
  capture?: [string, string][];
  terminal?: boolean;
}

export const WRITE_OPS: WriteOp[] = [
  // T1 - read-shaped writes and the org/account surface. No side effects.
  { tier: 1, verb: "POST", path: "/projects/{REF}/database/query/read-only", body: { query: "select 1 as n" } },
  { tier: 1, verb: "POST", path: "/projects/{REF}/database/query", body: { query: "select 1 as n" } },
  { tier: 1, verb: "POST", path: "/projects/{REF}/network-bans/retrieve" },
  { tier: 1, verb: "POST", path: "/projects/{REF}/network-bans/retrieve/enriched" },
  { tier: 1, verb: "POST", path: "/projects/{REF}/vanity-subdomain/check-availability", body: { vanity_subdomain: "pvlabprobe1" } },
  { tier: 1, verb: "GET", path: "/projects/available-regions" },
  { tier: 1, verb: "GET", path: "/snippets" },
  { tier: 1, verb: "GET", path: "/organizations" },
  { tier: 1, verb: "GET", path: "/organizations/{ORG}" },
  { tier: 1, verb: "GET", path: "/organizations/{ORG}/entitlements" },
  { tier: 1, verb: "GET", path: "/organizations/{ORG}/members" },
  { tier: 1, verb: "GET", path: "/organizations/{ORG}/projects" },
  { tier: 1, verb: "GET", path: "/profile" },
  { tier: 1, verb: "GET", path: "/projects" },

  // T2 - creates, which unlock the parameterised routes in T3.
  { tier: 2, verb: "POST", path: "/projects/{REF}/api-keys", body: { type: "publishable", name: "pvlab_probe" }, capture: [["API_KEY_ID", "id"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/config/auth/signing-keys", body: { algorithm: "ES256" }, capture: [["SIGNING_KEY_ID", "id"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/config/auth/signing-keys/legacy" },
  { tier: 2, verb: "POST", path: "/projects/{REF}/config/auth/third-party-auth", body: { oidc_issuer_url: "https://example.com" }, capture: [["TPA_ID", "id"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/config/auth/sso/providers", body: { type: "saml", metadata_url: "https://example.com/sso/metadata" }, capture: [["SSO_ID", "id"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/claim-token", capture: [["CLAIM_TOKEN", "token"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/secrets", body: [{ name: "PVLAB_PROBE", value: "x" }] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/functions", body: { slug: "pvlab-probe", name: "pvlab-probe", body: "Deno.serve(()=>new Response('ok'))" }, capture: [["FUNC_SLUG", "slug"], ["FUNC_ID", "id"], ["FUNC_VERSION", "version"]] },
  // GET so the PUT below can write the SAME root key back - a destructive
  // rotate here would invalidate anything already encrypted with it.
  { tier: 2, verb: "GET", path: "/projects/{REF}/pgsodium", capture: [["ROOT_KEY", "root_key"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/database/migrations", body: { query: "create table if not exists public.m1(i int);", name: "pvlab_probe" } },
  { tier: 2, verb: "PUT", path: "/projects/{REF}/database/migrations", body: { query: "create table if not exists public.m2(i int);", name: "pvlab_upsert" } },
  { tier: 2, verb: "GET", path: "/projects/{REF}/database/migrations", capture: [["MIGRATION_VERSION", "0.version"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/branches", body: { branch_name: "pvlab-probe" }, capture: [["BRANCH_ID", "id"]] },
  { tier: 2, verb: "GET", path: "/projects/{REF}/database/backups", capture: [["BACKUP_ID", "backups.0.id"]] },
  { tier: 2, verb: "POST", path: "/projects/{REF}/database/jit/invite", body: { email: "probe@example.com", roles: ["postgres"] }, capture: [["INVITE_ID", "invite_id"]] },
  { tier: 2, verb: "GET", path: "/projects/{REF}/actions", capture: [["RUN_ID", "0.id"]] },

  // T3 - the parameterised reads.
  { tier: 3, verb: "GET", path: "/projects/{REF}/api-keys/{API_KEY_ID}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/config/auth/signing-keys/{SIGNING_KEY_ID}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/config/auth/sso/providers/{SSO_ID}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/config/auth/third-party-auth/{TPA_ID}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/database/migrations/{MIGRATION_VERSION}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/functions/{FUNC_SLUG}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/functions/{FUNC_SLUG}/body" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/branches/pvlab-probe" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/actions/{RUN_ID}" },
  { tier: 3, verb: "GET", path: "/projects/{REF}/actions/{RUN_ID}/logs" },
  { tier: 3, verb: "GET", path: "/organizations/{ORG}/project-claim/{CLAIM_TOKEN}" },
  { tier: 3, verb: "GET", path: "/branches/{BRANCH_ID}" },
  { tier: 3, verb: "GET", path: "/branches/{BRANCH_ID}/diff" },

  // T4 - reversible config mutations.
  { tier: 4, verb: "PATCH", path: "/projects/{REF}", body: { name: "z02-writes" } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/config/auth", body: { api_max_request_duration: 10 } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/postgrest", body: { max_rows: 1000 } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/config/realtime", body: { connection_pool: 2 } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/config/storage", body: { fileSizeLimit: 52428800 } },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/config/database/postgres", body: { max_connections: 60 } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/config/database/pooler", body: { default_pool_size: 15 } },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/ssl-enforcement", body: { requestedConfig: { database: false } } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/network-restrictions", body: { dbAllowedCidrs: ["0.0.0.0/0"] } },
  { tier: 4, verb: "POST", path: "/projects/{REF}/network-restrictions/apply", body: { dbAllowedCidrs: ["0.0.0.0/0"] } },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/api-keys/legacy" },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/api-keys/{API_KEY_ID}", body: { name: "pvlab_probe2" } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/config/auth/signing-keys/{SIGNING_KEY_ID}", body: { status: "standby" } },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/config/auth/sso/providers/{SSO_ID}", body: {} },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/functions/{FUNC_SLUG}", body: { name: "pvlab-probe2" } },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/functions", body: [{ id: "{FUNC_ID}", slug: "pvlab-probe", name: "pvlab-probe", status: "ACTIVE", version: "{FUNC_VERSION}" }] },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/pgsodium", body: { root_key: "{ROOT_KEY}" } },
  { tier: 4, verb: "PATCH", path: "/projects/{REF}/database/migrations/{MIGRATION_VERSION}", body: {} },
  { tier: 4, verb: "PUT", path: "/projects/{REF}/jit-access", body: { state: "disabled" } },
  { tier: 4, verb: "POST", path: "/projects/{REF}/cli/login-role", body: { read_only: true } },
  { tier: 4, verb: "PATCH", path: "/branches/{BRANCH_ID}", body: { branch_name: "pvlab-probe" } },
  { tier: 4, verb: "POST", path: "/branches/{BRANCH_ID}/reset" },
  { tier: 4, verb: "POST", path: "/branches/{BRANCH_ID}/push" },
  { tier: 4, verb: "POST", path: "/branches/{BRANCH_ID}/merge" },
  { tier: 4, verb: "POST", path: "/branches/{BRANCH_ID}/restore" },

  // T5 - lifecycle and gated surfaces. Non-terminal, but they touch the instance.
  { tier: 5, verb: "POST", path: "/projects/{REF}/readonly/temporary-disable" },
  { tier: 5, verb: "POST", path: "/projects/{REF}/database/webhooks/enable" },
  { tier: 5, verb: "POST", path: "/projects/{REF}/database/backups/restore-point", body: { name: "pvlabrp" } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/database/backups/undo", body: { name: "pvlabrp" } },
  { tier: 5, verb: "PATCH", path: "/projects/{REF}/database/backups/schedule", body: { schedule_for: "daily" } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/read-replicas/setup", body: { read_replica_region: "ap-southeast-1" } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/read-replicas/remove", body: { database_identifier: "{REF}" } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/database/jit", body: { role: "postgres", rhost: "0.0.0.0/0" } },
  { tier: 5, verb: "PUT", path: "/projects/{REF}/database/jit", body: { user_id: "00000000-0000-0000-0000-000000000000", roles: ["postgres"] } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/custom-hostname/initialize", body: { custom_hostname: "probe.example.com" } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/custom-hostname/reverify" },
  { tier: 5, verb: "POST", path: "/projects/{REF}/custom-hostname/activate" },
  { tier: 5, verb: "POST", path: "/projects/{REF}/vanity-subdomain/activate", body: { vanity_subdomain: "pvlabprobe1" } },
  { tier: 5, verb: "POST", path: "/projects/{REF}/restore/cancel" },
  { tier: 5, verb: "POST", path: "/projects/{REF}/config/realtime/shutdown" },
  { tier: 5, verb: "POST", path: "/projects/{REF}/restart" },

  // T6 - deletes, cleaning up what T2 made.
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/database/jit/invite/{INVITE_ID}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/database/jit/00000000-0000-0000-0000-000000000000" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/secrets", body: ["PVLAB_PROBE"] },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/functions/{FUNC_SLUG}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/config/auth/third-party-auth/{TPA_ID}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/config/auth/sso/providers/{SSO_ID}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/config/auth/signing-keys/{SIGNING_KEY_ID}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/api-keys/{API_KEY_ID}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/claim-token" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/cli/login-role" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/network-bans", body: { ipv4_addresses: ["192.0.2.1"] } },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/custom-hostname" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/vanity-subdomain" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/database/migrations" },
  { tier: 6, verb: "DELETE", path: "/branches/{BRANCH_ID}" },
  { tier: 6, verb: "DELETE", path: "/projects/{REF}/branches" },

  // T7 - terminal or billable. Gated behind the module's `includeTerminal`.
  { tier: 7, verb: "POST", path: "/projects/{REF}/database/backups/restore", body: { id: "{BACKUP_ID}" }, terminal: true },
  { tier: 7, verb: "POST", path: "/projects/{REF}/database/backups/restore-pitr", body: { recovery_time_target_unix: 0 }, terminal: true },
  { tier: 7, verb: "POST", path: "/projects/{REF}/upgrade", body: { target_version: "17" }, terminal: true },
  { tier: 7, verb: "POST", path: "/projects/{REF}/config/disk", body: { attributes: { size_gb: 8 } }, terminal: true },
  { tier: 7, verb: "PATCH", path: "/projects/{REF}/billing/addons", body: { addon_type: "compute_instance", addon_variant: "ci_micro" }, terminal: true },
  { tier: 7, verb: "DELETE", path: "/projects/{REF}/billing/addons/ci_micro", terminal: true },
  { tier: 7, verb: "PATCH", path: "/projects/{REF}/database/password", body: { password: "Pvlab-probe-1!" }, terminal: true },
];

/**
 * Operations in the document that this experiment cannot reach, and why. Kept
 * as data so the count in the report adds up to the document's own total
 * rather than quietly ignoring the remainder.
 */
export const UNREACHABLE: { path: string; verb: string; why: string }[] = [
  { verb: "GET", path: "/v1/oauth/authorize", why: "browser redirect flow, needs a registered OAuth app" },
  { verb: "GET", path: "/v1/oauth/authorize/project-claim", why: "browser redirect flow" },
  { verb: "POST", path: "/v1/oauth/token", why: "needs an OAuth app + authorization code" },
  { verb: "POST", path: "/v1/oauth/revoke", why: "needs an OAuth app + issued token" },
  { verb: "POST", path: "/v1/organizations", why: "creates a real organization; litters the account" },
  { verb: "POST", path: "/v1/organizations/{slug}/project-claim/{token}", why: "transfers the project out of the org under test" },
  { verb: "GET", path: "/v1/snippets/{id}", why: "needs a SQL snippet, which only the dashboard creates" },
  { verb: "POST", path: "/v1/projects/{ref}/functions/deploy", why: "multipart/form-data, not JSON" },
  { verb: "POST", path: "/v1/projects/{ref}/database/jit/invite/accept", why: "needs the emailed invite token" },
  { verb: "PATCH", path: "/v1/projects/{ref}/actions/{run_id}/status", why: "writes to a CI action run we do not own" },
  { verb: "DELETE", path: "/v1/projects/{ref}", why: "the module's own cleanup does this in finally" },
  { verb: "POST", path: "/v1/projects", why: "the module's own control step does this" },
  { verb: "POST", path: "/v1/projects/{ref}/pause", why: "parks the project by definition; sweeping it would make the zero-wakers reading meaningless" },
  { verb: "POST", path: "/v1/projects/{ref}/restore", why: "wakes the project by definition; same reason" },
];
