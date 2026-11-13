# hook-gated-signup

The managed Auth surface that an edge-scored, hook-enforced signup design
rests on: a Worker verifies a CAPTCHA and scores the request, then forwards it
to Auth with a secret key and the client's address in `Sb-Forwarded-For`; a
before-user-created hook makes the decision in Postgres. Each row checks a
claim from the Auth server code (supabase/auth at 8872586) or the docs against
a managed project. Sources: https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook,
https://supabase.com/docs/guides/auth/rate-limits (IP address forwarding),
https://supabase.com/docs/guides/auth/auth-captcha.

Self-provisioning, no OpenTofu state: HG01 creates one `hg-*` Micro project
on the Pro org (`PVLAB_ORG_PRO`), deploys one Edge Function for the HTTP hook
row, and deletes the project in `finally`.

| id | claim |
|---|---|
| HG01a | with IP address forwarding off, the IP the hook sees for a direct `/auth/v1/signup` is the leftmost client-supplied `X-Forwarded-For` entry (code: `utilities.GetIPAddress` trusts XFF from any peer) |
| HG01b | with forwarding on, `Sb-Forwarded-For` is honoured only with a secret key (docs), although the Auth server does not check the key type (code); per key, email signup and anonymous sign-in |
| HG01c | a secret-key `/signup` skips the Auth server's CAPTCHA check (code: admin credentials skip `verifyCaptcha`) |
| HG01d | an HTTP hook that refuses with 200 and an error body reaches the client with the body's `http_code`; a 400 reply becomes a 500 (code: hookshttp.go reads a body only on 200/202) |
| HG01e | signup `options.data` reaches the hook as `user.user_metadata` |
| HG01f | an anonymous sign-in with data fires before-user-created |
| HG01g | the project's edge logs carry `request.cf` fields, JA4 among them |

## Run

```bash
export PVLAB_ORG_PRO=<pro-org-slug>
sx SUPABASE_ACCESS_TOKEN -- make probe        # HG01, 44-46 s per 2026-11-12 run, provisioning included
sx SUPABASE_ACCESS_TOKEN -- make sweep        # list hg-* leftovers
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

Results and their limits: `RUNLOG.md`.
