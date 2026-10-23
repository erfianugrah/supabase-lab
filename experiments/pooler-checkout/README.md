# pooler-checkout

What a client sees when the Supavisor transaction pool has no free backend,
what a client-side fallback costs, and how three Node drivers' pools behave
when the TCP connection to the pooler is reset. Self-provisioning: the modules
create one Micro project through the Management API, share it, and PC09
deletes it. No OpenTofu state.

Measured results and their limits: `RUNLOG.md`.

| Module | Question |
|---|---|
| PC01 | Hold the transaction pool with N `pg_sleep` statements (N = measured pool size); what does client N+1 see, after how long, and does a shorter hold just queue it? |
| PC02 | On the checkout failure, switch to the session pooler, direct, or the dedicated pooler (IPv4 add-on): how long does the switch take from an IPv4-only vantage? |
| PC03 | A toxiproxy container resets or cuts the TCP connection between the client and Supavisor: pool eviction, errors after the fault clears, retry-once, crashes, for node-postgres, postgres.js and Prisma |
| PC04 | Which pooler host prefix the API reports, what the other prefix answers for the same tenant, and the `aws-0` host lint |
| PC05 | Does the pool-slot wait (60 s on PC01) move with session mode or a client setting (`statement_timeout`, `options`, connect timeout)? |
| PC06 | A `login` event trigger delays the pooler's backend logins by 0, 8 or 20 s: does `ECHECKOUTTIMEOUT ... after 15000ms` appear while the pool has free slots? |
| PC07 | Set `default_pool_size` 5 through the Management API: effective pool and the checkout timeout |
| PC09 | Teardown and confirm the project left `GET /projects` |

`lib/lint-pooler-hosts.ts` is the lint as a CLI:
`bun lib/lint-pooler-hosts.ts [--all-prefixes] <paths...>`, exit 1 when it
flags something. `make lint` runs it over the repo.

## Run

Needs bun, node, docker (toxiproxy for PC03) and a Pro org.

```sh
SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<org slug> make probe
make test      # unit tests: summary arithmetic and the lint
make sweep     # delete leftover projects named with PREFIX (default pc-checkout-)
```

PC01 holds backends for up to 75 s per trial and PC02 waits out one 60 s
checkout timeout, so the PC01-PC04 run is about 40 minutes; PC01 with PC05 to
PC07 took 24 minutes on 2026-10-23. Project names start
with `PREFIX`; set `PVLAB_PC_PREFIX` to change it, `PVLAB_PC_REGION` for the
region, `PVLAB_PC_SIZE` for the compute size (default `micro`).
`PVLAB_PC_ADOPT=<json with ref and pw>` reuses an existing project and PC09
will not delete it. PC07 changes the project's pool size and PC06 creates and
drops a `login` event trigger, so run them on a throwaway project only.
