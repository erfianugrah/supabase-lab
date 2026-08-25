# Tenant Cost Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or implement this plan task-by-task in-session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenant-cost attribution + invoice reconciliation service that turns Supabase usage into a per-project cost ledger, plus the Gatekeeper policy templates that gate its access.

**Architecture:** A Bun CLI (`tenant-ledger`, new repo) polls the Supabase Management API through Gatekeeper with a scoped read-only key (dogfoods the proven scoped-proxy pattern; the PAT never leaves the gateway). It translates each poll into idempotent usage events (M06 pattern) written into a dedicated control-plane Supabase project ("ledger-store", own org) via that project's own PostgREST (M05 pattern), then flushes the `(tenant_id, meter, window_start)` rollup. Monthly, an operator-run invoice parser (M07, section-aware) ingests the real invoice PDF; a SQL reconciliation view compares computed cost vs billed cost per project.

**Tech stack:** Bun (TypeScript), Supabase Management API (via Gatekeeper), PostgREST on the ledger-store project, pdftotext, composer pipeline for the hourly schedule, Gatekeeper (Hono/Workers) for the policy templates.

**Capabilities (used as requirement IDs):**
- C1: per-project compute cost enumeration from the live org, invoice-aligned
- C2: durable, replay-safe usage event + rollup store (M06 properties)
- C3: month-to-date per-project cost view with explicit unpriced-meter flagging
- C4: invoice ingestion + reconciliation view (computed vs billed, per ref)
- C5: Gatekeeper per-tenant + poller IAM policy templates with proven deny boundaries
- C6: production provisioning + hourly schedule via composer pipeline

**Scope note:** data-plane (`{ref}.supabase.co/rest/...`) proxying is deliberately OUT (deferred - it meters activity, not cost; see session 2026-08-18). Nothing in this plan requires it.

---

## Locked decisions (with rejected alternatives)

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | Poller calls the Management API through Gatekeeper (`{GATEKEEPER_URL}/supabase/v1/...`) with a scoped read-only key | PAT stays server-side in the gateway; every poller call is metered (proven exact) + auditable | Poller holding the PAT - a second copy of a god credential |
| D2 | Store = dedicated Supabase project in its own org | Settled 2026-08-18; PostgREST is the read surface; real billing semantics (the store pays for itself, like rent) | Store inside Gatekeeper (D1 analytics) - couples billing durability to a retention-windowed event log |
| D3 | Schema in `public`, RLS enabled with zero policies | PostgREST exposes `public` by default (M05 finding: custom schema needs db-schemas config); service_role bypasses RLS; anon/authenticated denied by default | `metering` schema + db-schemas config - more moving parts for v1 |
| D4 | Billable meters: `compute.hour.<tier>`, `api.request.<kind>`. Gauges (`db_bytes`, status) go to `samples` only. Disk/PITR/custom-domain/egress are invoice-only | No Management API endpoint exists for provisioned disk GB-hrs (verified against the supabase-api spec); summing a gauge is meaningless | pretending db size is the disk charge - it is used bytes, not provisioned |
| D5 | M06 schema verbatim: append-only events + unique `idempotency_key` + rollup upsert keyed `(tenant_id, meter, window_start)` | Proven: replay-safe flush, late-event recompute, duplicate rejection | counters-in-place - not replayable or auditable |
| D6 | Compute meter named by INVOICE tier (`micro`/`small`); unknown addon variants become `compute.hour.unknown:<variant>` with no rate-card row | Recon join against invoice sections is 1:1; unknown SKUs flag as NULL-priced, never silently zeroed | sku-verbatim meters - breaks the recon join |
| D7 | Invoice ingest = operator-run Bun CLI using pdftotext; lines stored in the ledger-store | The PDF is the settlement layer with legal weight; section-aware parsing fixes the M07 caveat as much as the format allows | PDF parsing in the Worker - pdftotext cannot run there |
| D8 | Hourly schedule = composer pipeline `shell_command` on the composer host | User convention: pipelines replace cron containers | ofelia / cron container - duplicate scheduler |
| D9 | New repo `~/work/tenant-ledger`; Gatekeeper changes are +2 templates, not a new module | Production service graduates from the supabase-lab experiment; Gatekeeper stays a pure proxy | growing the experiment in supabase-lab - that repo is for probes |

## System shape

```
operator PAT --> Gatekeeper (upstream token, server-side)
                     | scoped poller key (supabase read-only)
tenant-ledger poller (bun CLI, hourly via composer pipeline)
  GET  /supabase/v1/organizations/{slug}/projects
  per project:
    GET  /supabase/v1/projects/{ref}/billing/addons           -> sku tier
    POST /supabase/v1/projects/{ref}/database/query/read-only -> db_bytes (healthy only)
    GET  /supabase/v1/projects/{ref}/analytics/endpoints/usage.api-counts?interval=1hr
  -> usage_events (idempotency keys) -> PostgREST upsert into ledger-store
  -> POST /rest/v1/rpc/flush_rollup
ledger-store project (own org)
  samples / usage_events / usage_rollup / rate_card / invoices / invoice_lines
  views: cost_month_to_date, invoice_reconciliation
monthly (operator, local):
  ledger ingest-invoice <pdf> --invoice-id <id> --window-start <ts> --window-end <ts>
  ledger reconcile --invoice-id <id>
```

## File map

```
~/work/tenant-ledger/
  package.json  tsconfig.json  biome.json  .gitignore  .env.example  README.md
  schema/schema.sql
  src/config.ts   - env loading
  src/gw.ts       - Management API client via the gateway
  src/collect.ts  - org enumeration + per-project collectors
  src/events.ts   - sample -> usage_events + idempotency keys (pure)
  src/store.ts    - PostgREST writer/reader for the ledger-store
  src/invoice.ts  - section-aware invoice parser
  src/report.ts   - cost + reconciliation rendering (pure)
  src/cli.ts      - poll / flush / report / ingest-invoice / reconcile
  scripts/provision-store.ts    - one-time production provisioning (PAT direct)
  scripts/integration-live.ts   - live end-to-end proof on a throwaway store
  test/*.test.ts
~/gatekeeper/
  dashboard/src/lib/policy-templates.ts   (+2 templates)
  test/policy-templates.test.ts           (+proven deny boundaries)
  docs/GUIDE.md                            (Policy Templates appendix sync)
```

---

## Task 1: Scaffold the tenant-ledger repo

**Satisfies:** none (scaffolding)

**Files:**
- Create: `~/work/tenant-ledger/package.json`
- Create: `~/work/tenant-ledger/tsconfig.json`
- Create: `~/work/tenant-ledger/biome.json`
- Create: `~/work/tenant-ledger/.gitignore`
- Create: `~/work/tenant-ledger/.env.example`

- [ ] **Step 1: Create the skeleton**

```bash
mkdir -p ~/work/tenant-ledger/{src,test,schema,scripts}
cd ~/work/tenant-ledger && git init
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "tenant-ledger",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "poll": "bun src/cli.ts poll",
    "report": "bun src/cli.ts report"
  },
  "devDependencies": {
    "@biomejs/biome": "^2",
    "bun-types": "^1",
    "typescript": "^5"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun-types"],
    "skipLibCheck": true
  }
}
```

- [ ] **Step 4: Write `biome.json`**

```json
{
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true, "rules": { "recommended": true } }
}
```

- [ ] **Step 5: Write `.gitignore` and `.env.example`**

```
# .gitignore
node_modules
.env
```

```
# .env.example - copy to .env, fill in, never commit .env
GATEKEEPER_URL=          # gateway base URL, no trailing slash
GATEKEEPER_KEY=          # scoped poller key minted by Task 12 step 3
STORE_REF=               # ledger-store project ref (Task 10)
STORE_SECRET_KEY=        # service_role key of the ledger-store project
TENANT_ORG_SLUG=         # slug of the org being metered
POLL_WINDOW_MINUTES=60   # poll event window; re-polls in the same window are idempotent
# SUPABASE_PAT=          # operator-only, scripts/provision-store.ts + integration-live.ts
# TEST_ORG_SLUG=         # org allowed to host throwaway integration projects
```

- [ ] **Step 6: Install + verify toolchain**

Run: `cd ~/work/tenant-ledger && bun install && bun run typecheck`
Expected: `bun install` succeeds; `tsc --noEmit` runs clean on the empty `src/`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold tenant-ledger"
```

---

## Task 2: Ledger-store schema (`schema/schema.sql`)

**Satisfies:** C2, C3, C4

**Files:**
- Create: `~/work/tenant-ledger/schema/schema.sql`
- Test: `~/work/tenant-ledger/test/schema-shape.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/schema-shape.test.ts
import { expect, test } from 'bun:test';

const sql = await Bun.file(new URL('../schema/schema.sql', import.meta.url)).text();

test('every create table is idempotent', () => {
  const bad = sql.match(/create table(?! if not exists)/gi);
  expect(bad).toBeNull();
});

test('every table has RLS enabled', () => {
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1]);
  expect(tables.length).toBe(6);
  for (const t of tables) {
    expect(sql).toContain(`alter table public.${t} enable row level security;`);
  }
});

test('rollup flush is an upsert on the M06 key', () => {
  expect(sql).toContain('on conflict (tenant_id, meter, window_start) do update');
  expect(sql).toContain('idempotency_key text not null unique');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/work/tenant-ledger && bun test test/schema-shape.test.ts`
Expected: FAIL - schema.sql does not exist yet, so the matchers find nothing.

- [ ] **Step 3: Write `schema/schema.sql`**

```sql
-- tenant-ledger store schema. Idempotent: safe to re-run (psql -f).
-- Lives in public because PostgREST exposes public by default (M05 finding);
-- RLS with zero policies denies anon/authenticated; service_role bypasses RLS.

-- Raw gauge samples per poll (informational only - never billed from).
create table if not exists public.samples (
  id bigint generated always as identity primary key,
  polled_at timestamptz not null default now(),
  project_ref text not null,
  name text,
  status text,
  sku text,
  db_bytes numeric,
  bucket_start timestamptz,
  rest_requests numeric,
  auth_requests numeric,
  realtime_requests numeric,
  storage_requests numeric
);

-- M06: append-only usage events. Re-polls re-insert the same key; duplicates ignored.
create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  meter text not null,
  quantity numeric not null,
  occurred_at timestamptz not null,
  idempotency_key text not null unique
);

-- M06: rollup keyed (tenant, meter, window). Flush is an upsert - replay-safe.
create table if not exists public.usage_rollup (
  tenant_id text not null,
  meter text not null,
  window_start timestamptz not null,
  total numeric not null,
  primary key (tenant_id, meter, window_start)
);

create table if not exists public.rate_card (
  meter text primary key,
  unit text not null,
  usd_per_unit numeric not null,
  source text not null,
  valid_from date not null default current_date
);

create table if not exists public.invoices (
  invoice_id text primary key,
  window_start timestamptz not null,
  window_end timestamptz not null,
  ingested_at timestamptz not null default now()
);

create table if not exists public.invoice_lines (
  id bigint generated always as identity primary key,
  invoice_id text not null references public.invoices (invoice_id) on delete cascade,
  section text not null,
  project_ref text,
  meter text,
  quantity numeric,
  rate numeric,
  amount numeric,
  unique nulls not distinct (invoice_id, section, project_ref, quantity, rate, amount)
);

-- M06 flush, exposed as a PostgREST rpc.
create or replace function public.flush_rollup() returns void language sql as $$
  insert into public.usage_rollup (tenant_id, meter, window_start, total)
  select tenant_id, meter, date_trunc('hour', occurred_at), sum(quantity)
  from public.usage_events
  group by tenant_id, meter, date_trunc('hour', occurred_at)
  on conflict (tenant_id, meter, window_start) do update set total = excluded.total;
$$;

-- Month-to-date computed cost. Meters with no rate-card row price as NULL: flag, never zero.
create or replace view public.cost_month_to_date as
select
  r.tenant_id as project_ref,
  r.meter,
  sum(r.total) as quantity,
  rc.unit,
  case when rc.meter is null then null else round(sum(r.total) * rc.usd_per_unit, 4) end as usd
from public.usage_rollup r
left join public.rate_card rc on rc.meter = r.meter
where r.window_start >= date_trunc('month', now())
group by r.tenant_id, r.meter, rc.unit, rc.meter, rc.usd_per_unit;

-- Computed vs billed per invoice line.
create or replace view public.invoice_reconciliation as
select
  il.invoice_id,
  il.section,
  il.project_ref,
  il.meter,
  il.quantity as billed_quantity,
  il.amount as billed_usd,
  c.computed_quantity,
  c.computed_usd,
  case
    when il.meter is null then 'invoice_only'
    when c.computed_quantity is null then 'no_usage_data'
    else 'compared'
  end as status
from public.invoice_lines il
join public.invoices i on i.invoice_id = il.invoice_id
left join lateral (
  select sum(r.total) as computed_quantity,
         round(sum(r.total * rc.usd_per_unit), 4) as computed_usd
  from public.usage_rollup r
  join public.rate_card rc on rc.meter = r.meter
  where il.meter is not null
    and r.tenant_id = il.project_ref
    and r.meter = il.meter
    and r.window_start >= i.window_start
    and r.window_start < i.window_end
) c on true;

alter table public.samples enable row level security;
alter table public.usage_events enable row level security;
alter table public.usage_rollup enable row level security;
alter table public.rate_card enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;

-- Seed the rate card from the 2026-08 invoice (extend as SKUs appear).
insert into public.rate_card (meter, unit, usd_per_unit, source) values
  ('compute.hour.micro', 'hour', 0.01344, 'invoice 2026-08'),
  ('compute.hour.small', 'hour', 0.0206, 'invoice 2026-08')
on conflict (meter) do nothing;
```

- [ ] **Step 4: Run the test - expect PASS**

Run: `bun test test/schema-shape.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add schema/schema.sql test/schema-shape.test.ts
git commit -m "feat: ledger-store schema (M06 event/rollup, rate card, recon views)"
```

---

## Task 3: Config + gateway Management-API client

**Satisfies:** C1 (transport half)

**Files:**
- Create: `~/work/tenant-ledger/src/config.ts`
- Create: `~/work/tenant-ledger/src/gw.ts`
- Test: `~/work/tenant-ledger/test/gw.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/gw.test.ts
import { expect, test } from 'bun:test';
import { mgmt } from '../src/gw';
import type { Config } from '../src/config';

const cfg: Config = {
  gatekeeperUrl: 'https://gw.example',
  gatekeeperKey: 'sbp_test',
  storeRef: 'abcdefghijklmnopqrst',
  storeSecretKey: 'k',
  tenantOrgSlug: 'acme',
};

test('mgmt addresses the gateway supabase proxy with the scoped key', async () => {
  let seen: { url: string; auth: string | null } = { url: '', auth: null };
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization ?? null };
    return new Response('[]', { status: 200 });
  };
  const res = await mgmt(cfg, 'GET', '/organizations/acme/projects', undefined, fetchFn as typeof fetch);
  expect(seen.url).toBe('https://gw.example/supabase/v1/organizations/acme/projects');
  expect(seen.auth).toBe('Bearer sbp_test');
  expect(res.status).toBe(200);
});

test('mgmt sends a JSON body only when given one', async () => {
  let hadContentType = false;
  let hadBody = false;
  const fetchFn = async (_u: string | URL | Request, init?: RequestInit) => {
    hadContentType = Boolean((init?.headers as Record<string, string>)?.['Content-Type']);
    hadBody = init?.body !== undefined;
    return new Response('{}', { status: 200 });
  };
  await mgmt(cfg, 'GET', '/projects', undefined, fetchFn as typeof fetch);
  expect(hadContentType).toBe(false);
  expect(hadBody).toBe(false);
  await mgmt(cfg, 'POST', '/projects/x/database/query/read-only', { query: 'select 1' }, fetchFn as typeof fetch);
  expect(hadContentType).toBe(true);
  expect(hadBody).toBe(true);
});

test('mgmt leaves non-JSON bodies un-parsed but keeps text', async () => {
  const fetchFn = async () => new Response('not json', { status: 500 });
  const res = await mgmt(cfg, 'GET', '/projects', undefined, fetchFn as typeof fetch);
  expect(res.status).toBe(500);
  expect(res.text).toBe('not json');
  expect(res.json).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/gw.test.ts`
Expected: FAIL - `../src/gw` has no module.

- [ ] **Step 3: Write `src/config.ts`**

```ts
export interface Config {
  /** Gateway base, no trailing slash, e.g. https://gatekeeper.example */
  gatekeeperUrl: string;
  /** Scoped poller key (sbp_-shaped bearer bound to the registered PAT). */
  gatekeeperKey: string;
  /** Ledger-store project ref. */
  storeRef: string;
  /** service_role key of the ledger-store project. */
  storeSecretKey: string;
  /** Slug of the tenant org being metered. */
  tenantOrgSlug: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env: ${k}`);
    return v;
  };
  return {
    gatekeeperUrl: need('GATEKEEPER_URL').replace(/\/+$/, ''),
    gatekeeperKey: need('GATEKEEPER_KEY'),
    storeRef: need('STORE_REF'),
    storeSecretKey: need('STORE_SECRET_KEY'),
    tenantOrgSlug: need('TENANT_ORG_SLUG'),
  };
}
```

- [ ] **Step 4: Write `src/gw.ts`**

```ts
import type { Config } from './config';

export interface GwResponse {
  status: number;
  json: unknown; // undefined when the body is not JSON
  text: string;
}

/**
 * One Management API call through the credential-proxy gateway.
 * `path` is the /v1-relative Management API path (e.g. '/projects/{ref}/billing/addons').
 * No retry: the poll is hourly and idempotent - a failed pass retries on the next run.
 */
export async function mgmt(
  cfg: Config,
  method: string,
  path: string,
  body?: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<GwResponse> {
  const res = await fetchFn(`${cfg.gatekeeperUrl}/supabase/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.gatekeeperKey}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}
```

- [ ] **Step 5: Run the tests - expect PASS; typecheck**

Run: `bun test test/gw.test.ts && bun run typecheck`
Expected: 3 tests PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/gw.ts test/gw.test.ts
git commit -m "feat: gateway management-api client"
```

---

## Task 4: Collectors (`src/collect.ts`)

**Satisfies:** C1

**Files:**
- Create: `~/work/tenant-ledger/src/collect.ts`
- Test: `~/work/tenant-ledger/test/collect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/collect.test.ts
import { expect, test } from 'bun:test';
import { lastCompleteBucket, skuFromAddons, type ApiBucket } from '../src/collect';

test('skuFromAddons: compute_instance variant wins, absence means micro', () => {
  expect(skuFromAddons({ selected_addons: [{ addon_type: 'compute_instance', addon_variant: 'ci_small' }] })).toBe('ci_small');
  expect(skuFromAddons({ selected_addons: [] })).toBe('none(micro)');
  expect(skuFromAddons({ selected_addons: [{ addon_type: 'pitr', addon_variant: 'pitr_7' }] })).toBe('none(micro)');
  expect(skuFromAddons({})).toBe('none(micro)');
});

test('lastCompleteBucket: only buckets whose hour fully elapsed qualify, newest wins', () => {
  const now = new Date('2026-08-19T12:30:00Z');
  const buckets: ApiBucket[] = [
    { timestamp: '2026-08-19T09:00:00Z', total_rest_requests: 5 },
    { timestamp: '2026-08-19T11:00:00Z', total_rest_requests: 7 }, // ends 12:00 - complete
    { timestamp: '2026-08-19T12:00:00Z', total_rest_requests: 1 }, // in progress
  ];
  expect(lastCompleteBucket(buckets, now)?.total_rest_requests).toBe(7);
  expect(lastCompleteBucket([], now)).toBeNull();
  expect(lastCompleteBucket([{ timestamp: '2026-08-19T12:00:00Z' }], now)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/collect.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write `src/collect.ts`**

```ts
import { mgmt } from './gw';
import type { Config } from './config';

export interface ApiBucket {
  timestamp: string; // bucket start, ISO
  total_rest_requests?: number;
  total_auth_requests?: number;
  total_realtime_requests?: number;
  total_storage_requests?: number;
}

export interface ProjectSample {
  ref: string;
  name: string;
  status: string;
  skuVariant: string; // raw addon variant, e.g. 'ci_small' or 'none(micro)'
  dbBytes: number | null; // pg_database_size, null when unread (not healthy / query failed)
  apiBucket: ApiBucket | null; // last COMPLETE hourly bucket
}

interface ProjectRow {
  id?: string;
  ref?: string;
  name?: string;
  status?: string;
}

export function skuFromAddons(json: unknown): string {
  const selected = (json as { selected_addons?: Array<{ addon_type?: string; addon_variant?: string }> } | undefined)
    ?.selected_addons;
  const list = Array.isArray(selected) ? selected : [];
  return list.find((a) => a?.addon_type === 'compute_instance')?.addon_variant ?? 'none(micro)';
}

/** Newest bucket whose hour has fully elapsed (bucket timestamp = bucket start). */
export function lastCompleteBucket(buckets: ApiBucket[], now: Date): ApiBucket | null {
  const cutoff = now.getTime() - 3_600_000;
  const complete = buckets.filter((b) => {
    const t = Date.parse(b.timestamp);
    return !Number.isNaN(t) && t <= cutoff;
  });
  return complete.length ? complete[complete.length - 1]! : null;
}

/**
 * One collection pass over the tenant org. Sequential: orgs are small
 * (dozens), and every call is metered through the gateway anyway.
 */
export async function collectOrg(cfg: Config, now: Date = new Date(), fetchFn: typeof fetch = fetch): Promise<ProjectSample[]> {
  const list = await mgmt(cfg, 'GET', `/organizations/${cfg.tenantOrgSlug}/projects`, undefined, fetchFn);
  if (list.status !== 200) throw new Error(`list projects: HTTP ${list.status}: ${list.text.slice(0, 200)}`);
  const projects = (Array.isArray(list.json) ? list.json : []) as ProjectRow[];
  const samples: ProjectSample[] = [];
  for (const p of projects) {
    const ref = p.ref ?? p.id ?? '';
    if (!ref) continue;
    const addons = await mgmt(cfg, 'GET', `/projects/${ref}/billing/addons`, undefined, fetchFn);
    const skuVariant = addons.status === 200 ? skuFromAddons(addons.json) : `unread:${addons.status}`;
    let dbBytes: number | null = null;
    if ((p.status ?? '') === 'ACTIVE_HEALTHY') {
      const q = await mgmt(
        cfg,
        'POST',
        `/projects/${ref}/database/query/read-only`,
        { query: 'select pg_database_size(current_database()) as bytes' },
        fetchFn,
      );
      const rows = Array.isArray(q.json) ? (q.json as Array<{ bytes?: number }>) : [];
      dbBytes = typeof rows[0]?.bytes === 'number' ? rows[0].bytes : null;
    }
    const u = await mgmt(
      cfg,
      'GET',
      `/projects/${ref}/analytics/endpoints/usage.api-counts?interval=1hr`,
      undefined,
      fetchFn,
    );
    const buckets = ((u.json as { result?: ApiBucket[] } | undefined)?.result ?? []) as ApiBucket[];
    samples.push({
      ref,
      name: p.name ?? '',
      status: p.status ?? 'unknown',
      skuVariant,
      dbBytes,
      apiBucket: u.status === 200 ? lastCompleteBucket(buckets, now) : null,
    });
  }
  return samples;
}
```

- [ ] **Step 4: Run tests - expect PASS**

Run: `bun test test/collect.test.ts && bun run typecheck`
Expected: 2 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/collect.ts test/collect.test.ts
git commit -m "feat: org collectors (sku tier, db size, last complete api bucket)"
```

---

## Task 5: Event translation (`src/events.ts`)

**Satisfies:** C2

**Files:**
- Create: `~/work/tenant-ledger/src/events.ts`
- Test: `~/work/tenant-ledger/test/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/events.test.ts
import { expect, test } from 'bun:test';
import { eventsForSample, skuTier, windowFloorIso } from '../src/events';
import type { ProjectSample } from '../src/collect';

test('skuTier maps addon variants to invoice tiers; unknown is flagged', () => {
  expect(skuTier('none(micro)')).toBe('micro');
  expect(skuTier('ci_micro')).toBe('micro');
  expect(skuTier('ci_small')).toBe('small');
  expect(skuTier('ci_large')).toBe('unknown:ci_large');
});

test('windowFloorIso floors to the window granularity', () => {
  expect(windowFloorIso(new Date('2026-08-19T12:47:33Z'), 60)).toBe('2026-08-19T12:00:00.000Z');
  expect(windowFloorIso(new Date('2026-08-19T12:47:33Z'), 15)).toBe('2026-08-19T12:45:00.000Z');
});

const base: ProjectSample = {
  ref: 'abcdefghij1234567890',
  name: 'shop',
  status: 'ACTIVE_HEALTHY',
  skuVariant: 'ci_small',
  dbBytes: 123,
  apiBucket: { timestamp: '2026-08-19T11:00:00Z', total_rest_requests: 10, total_auth_requests: 2 },
};

test('healthy project: one compute event with a deterministic idempotency key', () => {
  const evs = eventsForSample(base, '2026-08-19T12:00:00.000Z', 60);
  const compute = evs.find((e) => e.meter.startsWith('compute.hour'));
  expect(compute).toBeDefined();
  expect(compute!.quantity).toBe(1);
  expect(compute!.meter).toBe('compute.hour.small');
  expect(compute!.idempotency_key).toBe('abcdefghij1234567890|compute.hour.small|2026-08-19T12:00:00.000Z');
});

test('api bucket: one event per populated kind, keyed by bucket start', () => {
  const evs = eventsForSample(base, '2026-08-19T12:00:00.000Z', 60);
  const rest = evs.find((e) => e.meter === 'api.request.rest');
  expect(rest!.quantity).toBe(10);
  expect(rest!.occurred_at).toBe('2026-08-19T11:00:00.000Z');
  expect(rest!.idempotency_key).toBe('abcdefghij1234567890|api.request.rest|2026-08-19T11:00:00.000Z');
  expect(evs.some((e) => e.meter === 'api.request.auth')).toBe(true);
  expect(evs.some((e) => e.meter === 'api.request.storage')).toBe(false); // absent kind skipped
});

test('paused project accrues no compute hours but keeps api events', () => {
  const evs = eventsForSample({ ...base, status: 'INACTIVE' }, '2026-08-19T12:00:00.000Z', 60);
  expect(evs.some((e) => e.meter.startsWith('compute.hour'))).toBe(false);
  expect(evs.some((e) => e.meter === 'api.request.rest')).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/events.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write `src/events.ts`**

```ts
import type { ApiBucket, ProjectSample } from './collect';

export interface UsageEvent {
  tenant_id: string;
  meter: string;
  quantity: number;
  occurred_at: string; // ISO
  idempotency_key: string;
}

/**
 * Invoice-aligned compute tier for an addon variant. Unknown variants are
 * flagged in the meter name - they end up with no rate-card row and price as
 * NULL in the report, never silently zero.
 */
export function skuTier(variant: string): string {
  switch (variant) {
    case 'none(micro)':
    case 'ci_micro':
      return 'micro';
    case 'ci_small':
      return 'small';
    default:
      return `unknown:${variant}`;
  }
}

/** Floor a timestamp to the poll window granularity (UTC). */
export function windowFloorIso(d: Date, windowMinutes: number): string {
  const t = new Date(d.getTime());
  t.setUTCMinutes(Math.floor(t.getUTCMinutes() / windowMinutes) * windowMinutes, 0, 0);
  return t.toISOString();
}

const API_KINDS = [
  ['rest', 'total_rest_requests'],
  ['auth', 'total_auth_requests'],
  ['realtime', 'total_realtime_requests'],
  ['storage', 'total_storage_requests'],
] as const;

/**
 * Events for one poll pass over one project. Pure: same inputs -> same
 * idempotency keys, so re-polls into the store are duplicate-free.
 */
export function eventsForSample(s: ProjectSample, windowStartIso: string, windowMinutes: number): UsageEvent[] {
  const events: UsageEvent[] = [];
  if (s.status === 'ACTIVE_HEALTHY') {
    const meter = `compute.hour.${skuTier(s.skuVariant)}`;
    events.push({
      tenant_id: s.ref,
      meter,
      quantity: windowMinutes / 60,
      occurred_at: windowStartIso,
      idempotency_key: `${s.ref}|${meter}|${windowStartIso}`,
    });
  }
  if (s.apiBucket) {
    const bucketStart = new Date(Date.parse(s.apiBucket.timestamp)).toISOString();
    for (const [kind, field] of API_KINDS) {
      const qty = (s.apiBucket as ApiBucket)[field];
      if (typeof qty !== 'number') continue;
      const meter = `api.request.${kind}`;
      events.push({
        tenant_id: s.ref,
        meter,
        quantity: qty,
        occurred_at: bucketStart,
        idempotency_key: `${s.ref}|${meter}|${bucketStart}`,
      });
    }
  }
  return events;
}
```

- [ ] **Step 4: Run tests - expect PASS**

Run: `bun test test/events.test.ts && bun run typecheck`
Expected: 5 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat: poll-to-events translation with deterministic idempotency keys"
```

---

## Task 6: PostgREST store writer (`src/store.ts`)

**Satisfies:** C2

**Files:**
- Create: `~/work/tenant-ledger/src/store.ts`
- Test: `~/work/tenant-ledger/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/store.test.ts
import { expect, test } from 'bun:test';
import { upsertEvents } from '../src/store';
import type { Config } from '../src/config';
import type { UsageEvent } from '../src/events';

const cfg = {
  gatekeeperUrl: 'https://gw.example',
  gatekeeperKey: 'k',
  storeRef: 'abcdefghijklmnopqrst',
  storeSecretKey: 'secret',
  tenantOrgSlug: 'acme',
} satisfies Config;

const events: UsageEvent[] = [
  { tenant_id: 'r', meter: 'compute.hour.micro', quantity: 1, occurred_at: '2026-08-19T12:00:00.000Z', idempotency_key: 'a' },
];

test('upsertEvents posts to usage_events with ignore-duplicates resolution', async () => {
  let seen = { url: '', prefer: '', method: '' };
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: String(url),
      prefer: (init?.headers as Record<string, string>)?.Prefer ?? '',
      method: init?.method ?? '',
    };
    return new Response(JSON.stringify(events), { status: 201 });
  };
  const n = await upsertEvents(cfg, events, fetchFn as typeof fetch);
  expect(n).toBe(1);
  expect(seen.method).toBe('POST');
  expect(seen.url).toBe('https://abcdefghijklmnopqrst.supabase.co/rest/v1/usage_events?on_conflict=idempotency_key');
  expect(seen.prefer).toContain('resolution=ignore-duplicates');
});

test('upsertEvents is a no-op on an empty batch', async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return new Response('[]', { status: 201 });
  }) as typeof fetch;
  expect(await upsertEvents(cfg, [], fetchFn)).toBe(0);
  expect(called).toBe(false);
});

test('upsertEvents throws with body snippet on HTTP error', async () => {
  const fetchFn = (async () => new Response('duplicate key', { status: 409 })) as typeof fetch;
  await expect(upsertEvents(cfg, events, fetchFn)).rejects.toThrow('HTTP 409: duplicate key');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/store.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write `src/store.ts`**

```ts
import type { Config } from './config';
import type { ProjectSample } from './collect';
import type { UsageEvent } from './events';

const restBase = (cfg: Config) => `https://${cfg.storeRef}.supabase.co`;

function headers(cfg: Config, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: cfg.storeSecretKey,
    Authorization: `Bearer ${cfg.storeSecretKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Insert events; same-key rows are ignored, so re-polls are duplicate-free. Returns rows written. */
export async function upsertEvents(cfg: Config, events: UsageEvent[], fetchFn: typeof fetch = fetch): Promise<number> {
  if (!events.length) return 0;
  const res = await fetchFn(`${restBase(cfg)}/rest/v1/usage_events?on_conflict=idempotency_key`, {
    method: 'POST',
    headers: headers(cfg, { Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as unknown[]).length;
}

/** Insert one gauge sample row per project. Best-effort; failures report, not throw. */
export async function insertSamples(cfg: Config, samples: ProjectSample[], fetchFn: typeof fetch = fetch): Promise<void> {
  if (!samples.length) return;
  const rows = samples.map((s) => ({
    project_ref: s.ref,
    name: s.name,
    status: s.status,
    sku: s.skuVariant,
    db_bytes: s.dbBytes,
    bucket_start: s.apiBucket ? new Date(Date.parse(s.apiBucket.timestamp)).toISOString() : null,
    rest_requests: s.apiBucket?.total_rest_requests ?? null,
    auth_requests: s.apiBucket?.total_auth_requests ?? null,
    realtime_requests: s.apiBucket?.total_realtime_requests ?? null,
    storage_requests: s.apiBucket?.total_storage_requests ?? null,
  }));
  const res = await fetchFn(`${restBase(cfg)}/rest/v1/samples`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status >= 300) console.error(`samples insert failed (billing unaffected): HTTP ${res.status}`);
}

/** Run the rollup flush in the store (rpc). */
export async function flushRollup(cfg: Config, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(`${restBase(cfg)}/rest/v1/rpc/flush_rollup`, {
    method: 'POST',
    headers: headers(cfg),
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status >= 300) throw new Error(`flush_rollup: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Read a view or table through PostgREST. */
export async function queryView<T>(cfg: Config, path: string, fetchFn: typeof fetch = fetch): Promise<T[]> {
  const res = await fetchFn(`${restBase(cfg)}/rest/v1/${path}`, {
    headers: { apikey: cfg.storeSecretKey, Authorization: `Bearer ${cfg.storeSecretKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status >= 300) throw new Error(`queryView ${path}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T[];
}
```

- [ ] **Step 4: Run tests - expect PASS**

Run: `bun test test/store.test.ts && bun run typecheck`
Expected: 3 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: postgrest store writer (events upsert, samples, flush rpc, view reader)"
```

---

## Task 7: CLI + `poll` command + live integration script

**Satisfies:** C1, C2 (wired end to end)

**Files:**
- Create: `~/work/tenant-ledger/src/cli.ts`
- Create: `~/work/tenant-ledger/scripts/integration-live.ts`

- [ ] **Step 1: Write `src/cli.ts`**

```ts
#!/usr/bin/env bun
/**
 * tenant-ledger CLI. Subcommands:
 *   poll             collect -> samples + events upsert -> flush_rollup
 *   flush            re-run the rollup flush
 *   report           print the month-to-date cost table
 *   ingest-invoice <pdf> --invoice-id <id> --window-start <iso> --window-end <iso>
 *   reconcile --invoice-id <id>
 *
 * Glue layer: argv handling is deliberately thin; the logic under test lives
 * in src/collect.ts / src/events.ts / src/store.ts / src/report.ts / src/invoice.ts.
 */
import { loadConfig } from './config';
import { collectOrg } from './collect';
import { eventsForSample, windowFloorIso } from './events';
import { flushRollup, insertSamples, queryView, upsertEvents } from './store';
import { renderReport, renderReconciliation, type CostRow, type ReconRow } from './report';
import { parseInvoicePdf, SECTION_TO_METER } from './invoice';

const USAGE = `tenant-ledger <poll|flush|report|ingest-invoice|reconcile> [args]
  ingest-invoice <pdf> --invoice-id <id> --window-start <iso> --window-end <iso>
  reconcile --invoice-id <id>`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function poll(): Promise<void> {
  const cfg = loadConfig();
  const now = new Date();
  const windowMinutes = Number(process.env.POLL_WINDOW_MINUTES ?? '60');
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('POLL_WINDOW_MINUTES must be a positive number');
  const samples = await collectOrg(cfg, now);
  await insertSamples(cfg, samples);
  const windowStart = windowFloorIso(now, windowMinutes);
  const events = samples.flatMap((s) => eventsForSample(s, windowStart, windowMinutes));
  const inserted = await upsertEvents(cfg, events);
  await flushRollup(cfg);
  console.log(JSON.stringify({ projects: samples.length, events: events.length, events_written: inserted, windowStart }));
}

async function flush(): Promise<void> {
  const cfg = loadConfig();
  await flushRollup(cfg);
  console.log('rollup flushed');
}

async function report(): Promise<void> {
  const cfg = loadConfig();
  const rows = await queryView<CostRow>(cfg, 'cost_month_to_date');
  console.log(renderReport(rows));
}

async function ingestInvoice(args: string[]): Promise<void> {
  const pdf = args[0];
  const invoiceId = flag(args, '--invoice-id');
  const windowStart = flag(args, '--window-start');
  const windowEnd = flag(args, '--window-end');
  if (!pdf || !invoiceId || !windowStart || !windowEnd) throw new Error(USAGE);
  const lines = await parseInvoicePdf(pdf);
  if (!lines.length) throw new Error(`no per-ref lines parsed from ${pdf}`);
  const cfg = loadConfig();
  await upsertInvoice(cfg, invoiceId, windowStart, windowEnd, lines.map((l) => ({
    section: l.section,
    project_ref: l.ref,
    meter: SECTION_TO_METER[l.section] ?? null,
    quantity: l.quantity,
    rate: l.rate,
    amount: l.amount,
  })));
  console.log(JSON.stringify({ invoice_id: invoiceId, lines: lines.length, sections: [...new Set(lines.map((l) => l.section))] }));
}

async function reconcile(args: string[]): Promise<void> {
  const invoiceId = flag(args, '--invoice-id');
  if (!invoiceId) throw new Error(USAGE);
  const cfg = loadConfig();
  const rows = await queryView<ReconRow>(cfg, `invoice_reconciliation?invoice_id=eq.${encodeURIComponent(invoiceId)}`);
  console.log(renderReconciliation(rows));
}

async function upsertInvoice(
  cfg: ReturnType<typeof loadConfig>,
  invoiceId: string,
  windowStart: string,
  windowEnd: string,
  lines: Array<{ section: string; project_ref: string | null; meter: string | null; quantity: number; rate: number; amount: number }>,
): Promise<void> {
  const base = `https://${cfg.storeRef}.supabase.co`;
  const headers = {
    apikey: cfg.storeSecretKey,
    Authorization: `Bearer ${cfg.storeSecretKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
  const inv = await fetch(`${base}/rest/v1/invoices?on_conflict=invoice_id`, {
    method: 'POST',
    headers,
    body: JSON.stringify([{ invoice_id: invoiceId, window_start: windowStart, window_end: windowEnd }]),
  });
  if (inv.status >= 300) throw new Error(`invoices upsert: HTTP ${inv.status}: ${(await inv.text()).slice(0, 200)}`);
  const rows = lines.map((l) => ({ invoice_id: invoiceId, ...l }));
  const res = await fetch(`${base}/rest/v1/invoice_lines`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rows),
  });
  if (res.status >= 300) throw new Error(`invoice_lines upsert: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'poll':
    await poll();
    break;
  case 'flush':
    await flush();
    break;
  case 'report':
    await report();
    break;
  case 'ingest-invoice':
    await ingestInvoice(args);
    break;
  case 'reconcile':
    await reconcile(args);
    break;
  default:
    console.error(USAGE);
    process.exit(1);
}
```

Note: `upsertInvoice` is cli-level glue (importer for the two CLI-only flags); the pure parse + mapping logic lives in `invoice.ts` and is tested there.

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: clean (references to `report.ts` / `invoice.ts` resolve once Tasks 8-9 land - if run earlier, add them first or expect missing-module errors only).

- [ ] **Step 3: Write `scripts/integration-live.ts`**

```ts
/**
 * Live end-to-end proof, run by the operator (not bun test):
 * provisions a THROWAWAY ledger-store in TEST_ORG_SLUG, applies the schema,
 * runs one poll against the live tenant org, flushes, reads the views, deletes.
 *
 *   SUPABASE_PAT=... TEST_ORG_SLUG=... bun scripts/integration-live.ts
 *
 * Direct-PAT against api.supabase.com by design (one-time operator flow,
 * same model as the experiment harness). The store is deleted in finally.
 */
import { $ } from 'bun';
import { loadConfig } from '../src/config';
import { collectOrg } from '../src/collect';
import { eventsForSample, windowFloorIso } from '../src/events';
import { flushRollup, insertSamples, queryView, upsertEvents } from '../src/store';
import type { CostRow } from '../src/report';

const PAT = process.env.SUPABASE_PAT;
const ORG = process.env.TEST_ORG_SLUG;
if (!PAT || !ORG) throw new Error('missing env: SUPABASE_PAT and/or TEST_ORG_SLUG');

const API = 'https://api.supabase.com/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const dbPass = `${crypto.randomUUID()}Aa1!`;
const create = await api('POST', '/projects', {
  organization_slug: ORG,
  name: `ledger-it-${Date.now()}`,
  db_pass: dbPass,
  region: 'ap-southeast-1',
});
const ref = (create.json as { ref?: string } | undefined)?.ref ?? '';
if (create.status !== 201 || !ref) throw new Error(`create: HTTP ${create.status}: ${create.text.slice(0, 300)}`);

try {
  let status = '';
  for (let i = 0; i < 90 && status !== 'ACTIVE_HEALTHY'; i++) {
    await sleep(10_000);
    const p = await api('GET', `/projects/${ref}`);
    status = (p.json as { status?: string } | undefined)?.status ?? '';
  }
  if (status !== 'ACTIVE_HEALTHY') throw new Error(`store not healthy (status=${status})`);

  // schema via direct psql (handles function bodies; the gateway query endpoint is one-statement-per-call)
  const schemaPath = new URL('../schema/schema.sql', import.meta.url).pathname;
  const applied = await $`psql "postgres://postgres:${dbPass}@db.${ref}.supabase.co:5432/postgres" -f ${schemaPath}`.quiet();
  if (applied.exitCode !== 0) throw new Error(`schema apply failed: exit ${applied.exitCode}`);

  const keys = await api('GET', `/projects/${ref}/api-keys?reveal=true`);
  const rows = Array.isArray(keys.json) ? (keys.json as Array<{ name?: string; type?: string; api_key?: string }>) : [];
  const secret = rows.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key ?? '';
  if (!secret) throw new Error('no service_role key on the store');

  const cfg = { ...loadConfig(), storeRef: ref, storeSecretKey: secret };
  const now = new Date();
  const windowMinutes = 60;
  const samples = await collectOrg(cfg, now);
  await insertSamples(cfg, samples);
  const windowStart = windowFloorIso(now, windowMinutes);
  const events = samples.flatMap((s) => eventsForSample(s, windowStart, windowMinutes));
  const inserted = await upsertEvents(cfg, events);
  await flushRollup(cfg);
  const costs = await queryView<CostRow>(cfg, 'cost_month_to_date');
  console.log(JSON.stringify({ projects: samples.length, events: events.length, events_written: inserted, cost_rows: costs.length }));
  if (!costs.length) throw new Error('cost view returned no rows');
  console.log('INTEGRATION PASS');
} finally {
  const del = await api('DELETE', `/projects/${ref}`);
  console.log(`cleanup: DELETE /projects/${ref} -> HTTP ${del.status}`);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts scripts/integration-live.ts
git commit -m "feat: CLI (poll/flush/report/ingest/reconcile) + live integration script"
```

---

## Task 8: Report rendering (`src/report.ts`)

**Satisfies:** C3

**Files:**
- Create: `~/work/tenant-ledger/src/report.ts`
- Test: `~/work/tenant-ledger/test/report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/report.test.ts
import { expect, test } from 'bun:test';
import { renderReport, renderReconciliation, type ReconRow } from '../src/report';

// usd values below are pure arithmetic on the seeded rate card
// (0.01344/hr micro, 0.0206/hr small - from the session invoice evidence): derived, not recalled.
// verified: 720*0.01344=9.6768, 120*0.0206=2.472, 715*0.01344=9.6096
test('report groups rows per project and totals priced meters', () => {
  const out = renderReport([
    { project_ref: 'r1', meter: 'compute.hour.micro', quantity: 720, unit: 'hour', usd: 9.6768 },
    { project_ref: 'r1', meter: 'api.request.rest', quantity: 15000, unit: null, usd: null },
    { project_ref: 'r2', meter: 'compute.hour.small', quantity: 120, unit: 'hour', usd: 2.472 },
  ]);
  expect(out).toContain('r1');
  expect(out).toContain('UNPRICED');
  expect(out).toContain('9.68');
  expect(out).toContain('total: $12.15 priced');
});

test('reconciliation marks invoice-only and compared rows', () => {
  const rows: ReconRow[] = [
    { invoice_id: 'INV-1', section: 'Compute Hours Micro', project_ref: 'r1', meter: 'compute.hour.micro', billed_quantity: 720, billed_usd: 9.68, computed_quantity: 715, computed_usd: 9.6096, status: 'compared' },
    { invoice_id: 'INV-1', section: 'Pro Plan', project_ref: null, meter: null, billed_quantity: 1, billed_usd: 25, computed_quantity: null, computed_usd: null, status: 'invoice_only' },
  ];
  const out = renderReconciliation(rows);
  expect(out).toContain('compared');
  expect(out).toContain('invoice_only');
  expect(out).toContain('billed $34.68');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/report.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write `src/report.ts`**

```ts
export interface CostRow {
  project_ref: string;
  meter: string;
  quantity: number;
  unit: string | null;
  usd: number | null; // null = no rate-card row: UNPRICED, never zeroed
}

export interface ReconRow {
  invoice_id: string;
  section: string;
  project_ref: string | null;
  meter: string | null;
  billed_quantity: number;
  billed_usd: number;
  computed_quantity: number | null;
  computed_usd: number | null;
  status: 'compared' | 'invoice_only' | 'no_usage_data';
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** Month-to-date cost table: per project, per meter, with UNPRICED flagged. */
export function renderReport(rows: CostRow[]): string {
  if (!rows.length) return 'no usage data for this month yet';
  const byProject = new Map<string, CostRow[]>();
  for (const r of rows) {
    const list = byProject.get(r.project_ref) ?? [];
    list.push(r);
    byProject.set(r.project_ref, list);
  }
  const lines: string[] = [];
  let total = 0;
  for (const [ref, rs] of [...byProject.entries()].sort()) {
    lines.push(ref);
    for (const r of rs) {
      const usd = r.usd === null ? 'UNPRICED' : money(r.usd);
      if (r.usd !== null) total += r.usd;
      lines.push(`  ${r.meter}  qty=${r.quantity}${r.unit ? ` ${r.unit}` : ''}  ${usd}`);
    }
  }
  const unpriced = rows.filter((r) => r.usd === null).length;
  lines.push(`total: ${money(Math.round(total * 100) / 100)} priced${unpriced ? `, ${unpriced} unpriced meter(s) flagged` : ''}`);
  return lines.join('\n');
}

/** Computed vs billed for one invoice, per line. */
export function renderReconciliation(rows: ReconRow[]): string {
  if (!rows.length) return 'no such invoice in the store';
  const lines: string[] = [];
  let billed = 0;
  for (const r of rows) {
    billed += r.billed_usd;
    const computed = r.computed_usd === null ? 'n/a' : money(r.computed_usd);
    lines.push(`[${r.status}] ${r.section} ${r.project_ref ?? '(no ref)'}: billed=${money(r.billed_usd)} computed=${computed}`);
  }
  lines.push(`billed ${money(Math.round(billed * 100) / 100)} total`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests - expect PASS**

Run: `bun test test/report.test.ts && bun run typecheck`
Expected: 2 tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts test/report.test.ts
git commit -m "feat: month-to-date report + reconciliation rendering"
```

---

## Task 9: Invoice parser (`src/invoice.ts`)

**Satisfies:** C4

**Files:**
- Create: `~/work/tenant-ledger/src/invoice.ts`
- Test: `~/work/tenant-ledger/test/invoice.test.ts`

The M07 caveat was rate-keyed parsing (a line is "compute" iff its rate is 0.01344/0.0206). This parser is section-aware: it tracks the current invoice section heading and attributes each per-ref line to it, so new sections land as `invoice_only` lines instead of being mis-bucketed. The section-heading regex is deliberately generic; `SECTION_TO_METER` is extended the first time a real invoice shows a new heading.

- [ ] **Step 1: Write the failing test**

```ts
// test/invoice.test.ts
import { expect, test } from 'bun:test';
import { parseInvoiceText, SECTION_TO_METER } from '../src/invoice';

// Synthetic pdftotext -layout output. Refs are invented 20-char strings; amounts are made up.
const FIXTURE = `
Supabase Pte. Ltd.
Invoice INV-2099-01
Billing period Jan 1 2099 - Jan 31 2099

Compute Hours Micro
abcdefghij1234567890  720  $0.01344  $9.68
bcdefghij12345678901  120.5  $0.01344  $1.62

Compute Hours Small
cdefghij123456789012  300  $0.0206  $6.18

Disk Size GB-Hrs
abcdefghij1234567890  5840  $0.000171  $1.00
`;

test('per-ref lines parse with their section attached', () => {
  const lines = parseInvoiceText(FIXTURE);
  expect(lines.length).toBe(4);
  expect(lines[0]).toEqual({ section: 'Compute Hours Micro', ref: 'abcdefghij1234567890', quantity: 720, rate: 0.01344, amount: 9.68 });
  expect(lines[1]!.section).toBe('Compute Hours Micro');
  expect(lines[2]!.section).toBe('Compute Hours Small');
  expect(lines[3]!.section).toBe('Disk Size GB-Hrs');
});

test('section mapping: compute sections map, everything else is invoice-only', () => {
  expect(SECTION_TO_METER['Compute Hours Micro']).toBe('compute.hour.micro');
  expect(SECTION_TO_METER['Compute Hours Small']).toBe('compute.hour.small');
  expect(SECTION_TO_METER['Disk Size GB-Hrs']).toBeUndefined(); // -> meter NULL at ingest
});

test('garbage text yields no lines', () => {
  expect(parseInvoiceText('hello world\n123 not a ref line\n').length).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/invoice.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write `src/invoice.ts`**

```ts
import { $ } from 'bun';

export interface InvoiceLine {
  section: string;
  ref: string | null;
  quantity: number;
  rate: number;
  amount: number;
}

// Section heading: Title-ish line with no leading ref; per-ref line: 20-char ref + qty + $rate + $amount
// (the row shape M07 proved against a real invoice). Sections are tracked, not matched by rate.
const SECTION_RE = /^([A-Z][A-Za-z0-9 ()/-]{2,})$/;
const REF_LINE_RE = /^([a-z0-9]{20})\s+(\d+(?:\.\d+)?)\s+\$?([\d.]+)\s+\$?([\d.]+)\s*$/;

/** Invoice section -> our meter. Unmapped sections ingest with meter NULL (invoice-only lines). */
export const SECTION_TO_METER: Record<string, string> = {
  'Compute Hours Micro': 'compute.hour.micro',
  'Compute Hours Small': 'compute.hour.small',
};

/** Section-aware parse of `pdftotext -layout` output. */
export function parseInvoiceText(text: string): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const s = SECTION_RE.exec(line);
    if (s && !REF_LINE_RE.test(line)) {
      section = s[1]!.trim();
      continue;
    }
    const m = REF_LINE_RE.exec(line);
    if (m) {
      lines.push({ section, ref: m[1]!, quantity: Number(m[2]), rate: Number(m[3]), amount: Number(m[4]) });
    }
  }
  return lines;
}

/** Parse a real invoice PDF. Requires pdftotext on PATH. */
export async function parseInvoicePdf(path: string): Promise<InvoiceLine[]> {
  const text = await $`pdftotext -layout ${path} -`.text();
  return parseInvoiceText(text);
}
```

- [ ] **Step 4: Run tests - expect PASS, then full suite**

Run: `bun test && bun run typecheck`
Expected: all suites PASS (schema-shape 3, gw 3, collect 2, events 5, store 3, report 2, invoice 3 = 21 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/invoice.ts test/invoice.test.ts
git commit -m "feat: section-aware invoice parser"
```

---

## Task 10: Production provisioning (`scripts/provision-store.ts`)

**Satisfies:** C6

**Files:**
- Create: `~/work/tenant-ledger/scripts/provision-store.ts`

One-time, operator-run, direct-PAT (same model as the experiment harness: a god credential used locally for provisioning, never shipped to a runner). The poller itself never sees this credential.

- [ ] **Step 1: Write the script**

```ts
/**
 * One-time production provisioning of the ledger-store:
 *   1. create the dedicated org if missing (POST /v1/organizations)
 *   2. create the ledger-store project in it
 *   3. wait for ACTIVE_HEALTHY
 *   4. apply schema/schema.sql via direct psql
 *   5. write STORE_REF / STORE_SECRET_KEY into .env (chmod 600)
 *
 *   SUPABASE_PAT=... LEDGER_ORG_NAME=tenant-ledger bun scripts/provision-store.ts
 */
import { $ } from 'bun';

const PAT = process.env.SUPABASE_PAT;
const ORG_NAME = process.env.LEDGER_ORG_NAME ?? 'tenant-ledger';
if (!PAT) throw new Error('missing env: SUPABASE_PAT');

const API = 'https://api.supabase.com/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

// 1. org
const orgs = await api('GET', '/organizations');
const orgList = Array.isArray(orgs.json) ? (orgs.json as Array<{ id?: string; name?: string }>) : [];
let orgSlug = orgList.find((o) => o.name === ORG_NAME)?.id ?? '';
if (!orgSlug) {
  const created = await api('POST', '/organizations', { name: ORG_NAME });
  if (created.status >= 300) throw new Error(`create org: HTTP ${created.status}: ${created.text.slice(0, 300)}`);
  const after = await api('GET', '/organizations');
  const afterList = Array.isArray(after.json) ? (after.json as Array<{ id?: string; name?: string }>) : [];
  orgSlug = afterList.find((o) => o.name === ORG_NAME)?.id ?? '';
  if (!orgSlug) throw new Error('org created but not resolvable by name');
}
console.log(`org: ${ORG_NAME} (${orgSlug})`);

// 2. project
const dbPass = `${crypto.randomUUID()}Aa1!`;
const create = await api('POST', '/projects', {
  organization_slug: orgSlug,
  name: 'ledger-store',
  db_pass: dbPass,
  region: 'ap-southeast-1',
});
const ref = (create.json as { ref?: string } | undefined)?.ref ?? '';
if (create.status !== 201 || !ref) throw new Error(`create project: HTTP ${create.status}: ${create.text.slice(0, 300)}`);
console.log(`project: ledger-store (${ref})`);

// 3. wait healthy
let status = '';
for (let i = 0; i < 90 && status !== 'ACTIVE_HEALTHY'; i++) {
  await sleep(10_000);
  const p = await api('GET', `/projects/${ref}`);
  status = (p.json as { status?: string } | undefined)?.status ?? '';
}
if (status !== 'ACTIVE_HEALTHY') throw new Error(`not healthy (status=${status})`);
console.log('healthy');

// 4. schema
const schemaPath = new URL('../schema/schema.sql', import.meta.url).pathname;
const applied = await $`psql "postgres://postgres:${dbPass}@db.${ref}.supabase.co:5432/postgres" -f ${schemaPath}`.quiet();
if (applied.exitCode !== 0) throw new Error(`schema apply failed: exit ${applied.exitCode}`);
console.log('schema applied');

// 5. .env
const keys = await api('GET', `/projects/${ref}/api-keys?reveal=true`);
const keyRows = Array.isArray(keys.json) ? (keys.json as Array<{ name?: string; type?: string; api_key?: string }>) : [];
const secret = keyRows.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key ?? '';
if (!secret) throw new Error('no service_role key revealed');

const envPath = new URL('../.env', import.meta.url).pathname;
const existing = await Bun.file(envPath).text().catch(() => '');
const setVar = (src: string, k: string, v: string) =>
  src.match(new RegExp(`^${k}=`, 'm'))
    ? src.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
    : `${src.trimEnd()}\n${k}=${v}\n`;
let env = existing;
env = setVar(env, 'STORE_REF', ref);
env = setVar(env, 'STORE_SECRET_KEY', secret);
await Bun.write(envPath, env);
await $`chmod 600 ${envPath}`;
console.log('.env updated (STORE_REF, STORE_SECRET_KEY). Remaining: GATEKEEPER_URL, GATEKEEPER_KEY, TENANT_ORG_SLUG (Task 12).');
```

- [ ] **Step 2: Run it (operator)**

Run: `cd ~/work/tenant-ledger && SUPABASE_PAT=... bun scripts/provision-store.ts`
Expected: org created or reused; project healthy; schema applied; `.env` has STORE_REF + STORE_SECRET_KEY. Takes ~2-3 min for the project to come up.

- [ ] **Step 3: Commit the script (never .env)**

```bash
git add scripts/provision-store.ts
git commit -m "feat: production provisioning script for the ledger-store"
```

---

## Task 11: Gatekeeper policy templates (+2) with proven deny boundaries

**Satisfies:** C5

**Files:**
- Modify: `~/gatekeeper/dashboard/src/lib/policy-templates.ts` (append to `SUPABASE_TEMPLATES`)
- Create: `~/gatekeeper/test/policy-templates-metering.test.ts`
- Modify: `~/gatekeeper/docs/GUIDE.md` ("Policy Templates" appendix - the lib file's header comment requires keeping it in sync)

NOTE on commits: `~/gatekeeper/.pi/harness.json` exists. If this task runs under the self-correcting loop, SKIP the commit step (the loop owns git state). Commit only for human/inline execution.

- [ ] **Step 1: Write the failing test**

```ts
// test/policy-templates-metering.test.ts
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, validatePolicy } from '../src/policy-engine';
import { classifySupabaseRequest } from '../src/supabase/classify';
import { POLICY_TEMPLATES, applyTemplate } from '../dashboard/src/lib/policy-templates';

// RequestContext shape mirrors test/policy-engine.test.ts usage.
const ctx = (action: string, resource: string) => [{ action, resource, fields: {} }];

const REF = 'abcdefghij1234567890';

describe('sb-usage-poller', () => {
  const template = POLICY_TEMPLATES.supabase.find((t) => t.id === 'sb-usage-poller');
  expect(template, 'template exists').toBeDefined();
  const policy = applyTemplate(template!, { resources: [] });
  // substitute the org placeholder with a concrete slug for evaluation
  const concrete = JSON.parse(JSON.stringify(policy).replaceAll('org:<slug>', 'org:acme'));

  it('validates', () => {
    expect(validatePolicy(concrete)).toEqual([]);
  });

  it('allows the four poller endpoints on the metered org', () => {
    const endpoints: Array<[string, string]> = [
      ['GET', '/v1/organizations/acme/projects'],
      ['GET', `/v1/projects/${REF}/billing/addons`],
      ['POST', `/v1/projects/${REF}/database/query/read-only`],
      ['GET', `/v1/projects/${REF}/analytics/endpoints/usage.api-counts?interval=1hr`],
    ];
    for (const [method, path] of endpoints) {
      const cls = classifySupabaseRequest(method, path);
      expect(cls, path).not.toBeNull();
      expect(evaluatePolicy(concrete, ctx(cls!.action, cls!.resource)), `${method} ${path}`).toBe(true);
    }
  });

  it('denies writes, mutable query endpoint, and other orgs', () => {
    const write = classifySupabaseRequest('PATCH', `/v1/projects/${REF}/billing/addons`);
    expect(evaluatePolicy(concrete, ctx(write!.action, write!.resource))).toBe(false);
    const mutableQuery = classifySupabaseRequest('POST', `/v1/projects/${REF}/database/query`);
    expect(evaluatePolicy(concrete, ctx(mutableQuery!.action, mutableQuery!.resource))).toBe(false);
    const otherOrg = classifySupabaseRequest('GET', '/v1/organizations/evil/projects');
    expect(evaluatePolicy(concrete, ctx(otherOrg!.action, otherOrg!.resource))).toBe(false);
  });
});

describe('sb-tenant-observer', () => {
  const template = POLICY_TEMPLATES.supabase.find((t) => t.id === 'sb-tenant-observer');
  expect(template, 'template exists').toBeDefined();
  const policy = applyTemplate(template!, { resources: [`project:${REF}`] });

  it('validates and reaches its own project metrics + analytics', () => {
    expect(validatePolicy(policy)).toEqual([]);
    const metrics = classifySupabaseRequest('GET', `/v1/projects/${REF}/analytics/endpoints/metrics`);
    expect(evaluatePolicy(policy, ctx(metrics!.action, metrics!.resource))).toBe(true);
    const usage = classifySupabaseRequest('GET', `/v1/projects/${REF}/analytics/endpoints/usage.api-counts`);
    expect(evaluatePolicy(policy, ctx(usage!.action, usage!.resource))).toBe(true);
  });

  it('denies another project and any write', () => {
    const other = 'bcdefghij12345678901';
    const metrics = classifySupabaseRequest('GET', `/v1/projects/${other}/analytics/endpoints/metrics`);
    expect(evaluatePolicy(policy, ctx(metrics!.action, metrics!.resource))).toBe(false);
    const write = classifySupabaseRequest('POST', `/v1/projects/${REF}/database/query`);
    expect(evaluatePolicy(policy, ctx(write!.action, write!.resource))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/gatekeeper && bun run test -- test/policy-templates-metering.test.ts`
Expected: FAIL - `template exists` assertions (no such template ids yet).

- [ ] **Step 3: Append the two templates to `SUPABASE_TEMPLATES` in `dashboard/src/lib/policy-templates.ts`**

```ts
	{
		id: 'sb-tenant-observer',
		group: 'Metering',
		label: 'Tenant observer - metrics + analytics read',
		description: "Read one tenant project's metrics scrape and usage analytics. Nothing else.",
		build: (c) => [
			{ effect: 'allow', actions: ['supabase:metrics:read', 'supabase:analytics:read'], resources: res(c, 'project:<ref>') },
		],
	},
	{
		id: 'sb-usage-poller',
		group: 'Metering',
		label: 'Usage poller - org enumerate + per-project reads',
		description:
			'Read-only access for the tenant-cost ledger poller: list org projects, read billing addons, run read-only queries, read usage analytics. Edit org:<slug> to the metered org.',
		build: () => [
			{
				effect: 'allow',
				actions: ['supabase:organizations:read', 'supabase:projects:read'],
				resources: ['org:<slug>', 'supabase:account'],
			},
			{
				effect: 'allow',
				actions: ['supabase:billing:read', 'supabase:database:read', 'supabase:analytics:read', 'supabase:metrics:read'],
				resources: ['project:*'],
			},
		],
	},
```

- [ ] **Step 4: Run the tests - expect PASS, plus the full suite**

Run: `bun run test -- test/policy-templates-metering.test.ts && bun run test`
Expected: the new file passes (7 tests) and the existing suite stays green (the new templates flow through the shared template-validation test too).

- [ ] **Step 5: Sync `docs/GUIDE.md`**

Add `sb-tenant-observer` and `sb-usage-poller` rows to the "Policy Templates" appendix, same table format as the existing entries.

- [ ] **Step 6: Commit (inline execution only - see harness note above)**

```bash
cd ~/gatekeeper
git add dashboard/src/lib/policy-templates.ts test/policy-templates-metering.test.ts docs/GUIDE.md
git commit -m "feat: metering policy templates (tenant observer, usage poller)"
```

---

## Task 12: Mint the poller key + deploy the hourly schedule

**Satisfies:** C5, C6

**Files:**
- Create: `~/work/tenant-ledger/README.md`

- [ ] **Step 1: Register the PAT as an upstream token (or reuse the existing supabase one)**

```bash
cd ~/gatekeeper
bun run cli upstream-tokens list
# if no supabase-scope token is registered yet:
bun run cli upstream-tokens create --help   # then create with scope=supabase
```

Expected: an `upt_...` id for the supabase upstream token.

- [ ] **Step 2: Render the poller policy from the template**

```bash
cd ~/gatekeeper
# replace REAL_ORG_SLUG with the metered org's slug
bun -e "
import { POLICY_TEMPLATES, applyTemplate } from './dashboard/src/lib/policy-templates.ts';
const t = POLICY_TEMPLATES.supabase.find((t) => t.id === 'sb-usage-poller');
const p = applyTemplate(t, { resources: [] });
console.log(JSON.stringify(JSON.parse(JSON.stringify(p).replaceAll('org:<slug>', 'org:REAL_ORG_SLUG')), null, 2));
" > /tmp/poller-policy.json
cat /tmp/poller-policy.json   # eyeball: org slug substituted, only read actions, project:* second statement
```

- [ ] **Step 3: Mint the key**

```bash
cd ~/gatekeeper
bun run cli keys create --name tenant-ledger-poller --upstream-token-id <upt_...> --policy @/tmp/poller-policy.json
```

Expected: a new key id + bearer. Copy the bearer into `~/work/tenant-ledger/.env` as `GATEKEEPER_KEY`, plus `GATEKEEPER_URL` and `TENANT_ORG_SLUG`.

- [ ] **Step 4: First live poll (the real end-to-end gate)**

Run: `cd ~/work/tenant-ledger && bun src/cli.ts poll && bun src/cli.ts report`
Expected: poll prints `{"projects":N,"events":...}` with HTTP 2xx all the way; report prints the month-to-date table with no UNPRICED rows for known SKUs. Run `poll` a SECOND time: `events_written` drops to ~0 (idempotency) and the report is unchanged - that is C2 proven in production.

- [ ] **Step 5: Write `README.md`** (runbook for the operator)

```markdown
# tenant-ledger

Per-project Supabase cost attribution + invoice reconciliation.

- `bun src/cli.ts poll` - one collection pass (hourly via composer pipeline)
- `bun src/cli.ts report` - month-to-date cost per project
- `bun src/cli.ts ingest-invoice <pdf> --invoice-id <id> --window-start <iso> --window-end <iso>` - monthly, operator-run
- `bun src/cli.ts reconcile --invoice-id <id>` - computed vs billed
- `bun test` - unit suite; `SUPABASE_PAT=... TEST_ORG_SLUG=... bun scripts/integration-live.ts` - live proof on a throwaway store
- `SUPABASE_PAT=... bun scripts/provision-store.ts` - one-time production store setup

Config: `.env` (see `.env.example`). Poller calls the Management API through
Gatekeeper with a scoped read-only key; the PAT never leaves the gateway.
Schema changes: edit `schema/schema.sql`, re-apply with
`psql "$STORE_PGURI" -f schema/schema.sql` (idempotent).
```

- [ ] **Step 6: Install on the composer host**

```bash
# on the composer host (verify bun is present first: bun --version)
git clone <tenant-ledger-remote-or-rsync> /opt/tenant-ledger
cd /opt/tenant-ledger && bun install
# copy the filled .env over (chmod 600), then:
set -a; . /opt/tenant-ledger/.env; set +a; bun src/cli.ts poll
```

Expected: identical JSON output to the local run in Step 4.

- [ ] **Step 7: Register the composer pipeline**

```bash
# shape per composer docs/api-reference.md (worked example: scheduled recyclarr sync);
# shell_command env is scrubbed, so the command sources .env explicitly.
curl -sS -X POST "$COMPOSER_URL/api/v1/pipelines" \
  -H "Authorization: Bearer $COMPOSER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "tenant-ledger-poll",
    "triggers": [{"type": "schedule", "config": {"cron": "7 * * * *"}}],
    "steps": [{
      "id": "poll",
      "name": "hourly usage poll",
      "type": "shell_command",
      "config": {"command": "set -a; . /opt/tenant-ledger/.env; set +a; cd /opt/tenant-ledger && bun src/cli.ts poll"},
      "timeout": "5m"
    }]
  }'
```

Expected: 2xx with the pipeline id. Trigger a manual run via the composer API and confirm the run record shows the poll JSON. Check `bun src/cli.ts report` the next day: ~24 compute-hour events per healthy project.

- [ ] **Step 8: Commit**

```bash
cd ~/work/tenant-ledger
git add README.md
git commit -m "docs: operator runbook"
```

---

## Self-review

**Coverage:** C1 -> Tasks 4, 7 (integration), 12 step 4. C2 -> Tasks 2, 5, 6, 12 step 4 (double-poll check). C3 -> Tasks 2 (view), 8, 12 step 4. C4 -> Tasks 2 (invoice tables + view), 7 (cli wiring), 9. C5 -> Task 11 (+ mint in Task 12 steps 1-3). C6 -> Tasks 10, 12 steps 6-7. No capability without a task.

**Placeholder scan:** no TBD/TODO steps. Three operator-supplied values are intentionally flagged inline where they are needed (metered org slug in Task 12 step 2, upstream token id in step 3, composer host env in step 7) - these are per-environment inputs, not plan gaps.

**Type consistency:** `ProjectSample` (collect.ts) fields `ref/name/status/skuVariant/dbBytes/apiBucket` match events.ts (`eventsForSample`) and store.ts (`insertSamples`) usage. `UsageEvent` field names are snake_case because they double as PostgREST rows - intentional. `CostRow`/`ReconRow` match the SQL views' output columns (`project_ref`, `meter`, `quantity`, `unit`, `usd` / `billed_quantity`, `computed_usd`, `status`). `skuTier` output feeds both the meter string and (via D6) the rate-card keys; `SECTION_TO_METER` values match the seeded `rate_card.meter` rows exactly.

**Known ceilings (deliberate):**
- Compute-hour crediting is poll-window granular: a project created/deleted between polls is over/under-credited by up to one window. The invoice reconciliation is the arbiter; shrink `POLL_WINDOW_MINUTES` to 15 to halve the error.
- `db_bytes` samples are informational only; provisioned disk GB-hrs cannot be measured through the Management API (D4) and reconcile from the invoice.
- Sequential collection: fine at dozens of projects; revisit with concurrency if the org passes ~100 projects (Management API rate limits first, gateway second).
