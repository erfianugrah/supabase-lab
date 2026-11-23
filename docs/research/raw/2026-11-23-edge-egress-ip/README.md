# Edge Function egress IPs (2026-11-23)

Question: what source address does an outbound `fetch` from a Supabase Edge
Function present, and how stable is it?

Setup: a throwaway Pro-org project in ap-southeast-1 (created and deleted the
same day), one function (`egress-probe.ts`) that fetches api.ipify.org and
returns the IP, a per-boot UUID and `SB_REGION`. Invoked from Singapore
between 01:38 and 01:50 UTC.

Arms: 30 sequential GETs, 3 bursts of 15 concurrent GETs, 32 GETs with an
`x-region` header, then 4 redeploys (forced new boots) each followed by 5
POSTs and 3 POSTs with `x-region: us-east-1`. Raw rows: `runs.tsv` (arm,
SB_REGION, ip, boot id).

Results (n = 139 rows, one project, one 12-minute window):

| region | egress IP | boots | requests |
|---|---|---|---|
| ap-southeast-1 | 13.214.168.194 | 5 | 111 |
| ap-southeast-1 | 13.214.202.160 | 2 | 16 |
| us-east-1 | 34.227.61.74 | 4 | 12 |

- Each address reverse-resolves to an AWS EC2 public hostname in that region.
- One IP per boot; different boots in the same region reused one of a small
  set of addresses.
- `x-region` on a GET was ignored (32 of 32 ran in ap-southeast-1); on a POST
  it was honoured and `x-sb-edge-region` echoed it. `?forceFunctionRegion=`
  worked on a GET.

Not measured: stability beyond 12 minutes, whether the addresses are shared
with other projects or tenants, other regions, whether Supabase documents or
commits to them. Do not tell a customer the IPs are static or allowlistable
from this run.
