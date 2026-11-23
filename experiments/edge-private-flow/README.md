# edge-private-flow

A customer-owned edge (Cloudflare Worker) in front of a hosted Edge Function
that calls a private integration API with an mTLS client certificate and the
caller's Supabase JWT. Results: `RUNLOG.md`. Research behind the arms:
`docs/research/2026-11-23-edge-private-api.md`.

```
make certs                      # badssl public client cert + a throwaway CA and named-curve client cert
sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_WORKERS_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make all
sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_WORKERS_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make destroy
```

- `supabase/functions/relay` - the function: front-secret gate, `getClaims`,
  outbound arms (`probe`, `mtls-ca`, `mtls-echo`, `jwt-upstream`, `all`).
- `workers/front` - adds `x-gw-secret`, pins `x-region` +
  `forceFunctionRegion`, proxies `/fn/*` and `/rest/v1/*`.
- `workers/upstream` - validates the forwarded token against the project JWKS
  (stand-in for an API gateway JWT policy).
- `setup.ts` - keys, signing-key check, lab user, RLS gate on
  `request.headers`, function secrets. `probe.ts` - the matrix.
- `certs/` and `evidence/` are gitignored (keys, tokens, refs).
