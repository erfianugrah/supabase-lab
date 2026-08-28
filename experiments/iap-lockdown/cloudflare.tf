# Cloudflare Access = the IAP.
#
#   iap_issuer (SaaS/OIDC): Access-for-SaaS acts as the OIDC IdP whose tokens
#     Supabase trusts via third-party auth. This is L10 (IAP-as-issuer) - the
#     data API serves only requests carrying an Access-issued identity.
#   iap_proxy (self-hosted): Access gates the Worker at <subdomain>.<zone>.
#     This is L11 (IAP-as-proxy) - the Worker holds the service key; the
#     load-bearing measurement is the direct-origin bypass.
#
# Everything is gated on enable_cloudflare so Phase A (Supabase only) still
# applies clean. The erfi_corp group and onetimepin IdP are existing
# account-level resources referenced by id, not recreated here.

locals {
  cf                  = var.enable_cloudflare ? 1 : 0
  proxy_hostname      = "${var.cf_subdomain}.${var.cf_zone_name}"
  proxy_callback_uris = ["https://${var.cf_subdomain}.${var.cf_zone_name}/cdn-cgi/access/callback"]
}

resource "cloudflare_zero_trust_access_policy" "allow" {
  count            = local.cf
  account_id       = var.cf_account_id
  name             = "iap-lockdown allow"
  decision         = "allow"
  session_duration = "24h"
  include {
    group = [var.cf_erfi_corp_group_id]
  }
}

# M2M gate for the proxy: an Access service token so the Worker can be called
# without a browser login (L12 - supabase-js through the Access-gated proxy).
# A service token needs its own non_identity policy on the app.
resource "cloudflare_zero_trust_access_service_token" "l12" {
  count      = local.cf
  account_id = var.cf_account_id
  name       = "iap-lockdown l12 m2m"
}

resource "cloudflare_zero_trust_access_policy" "allow_svc" {
  count            = local.cf
  account_id       = var.cf_account_id
  name             = "iap-lockdown allow service token"
  decision         = "non_identity"
  session_duration = "24h"
  include {
    service_token = [cloudflare_zero_trust_access_service_token.l12[0].id]
  }
}

# L10 issuer: Access-for-SaaS OIDC. The OIDC issuer is
# https://<team-domain>/cdn-cgi/access/sso/oidc/<client_id>, exposed as the
# resource's `domain` attribute; Supabase registers it as oidc_issuer_url.
resource "cloudflare_zero_trust_access_application" "iap_issuer" {
  count                     = local.cf
  account_id                = var.cf_account_id
  name                      = "iap-lockdown issuer"
  type                      = "saas"
  session_duration          = "24h"
  app_launcher_visible      = false
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.allow[0].id]
  allowed_idps              = [var.cf_pin_idp_id]
  saas_app {
    auth_type = "oidc"
    # Cloudflare rejects client_credentials for SaaS OIDC apps (measured
    # 2026-08-28) - the token for L10d must come from the interactive
    # authorization-code login (the chrome/Gmail-PIN flow).
    redirect_uris = local.proxy_callback_uris
    grant_types   = ["authorization_code_with_pkce"]
    scopes        = ["openid", "email", "profile", "groups"]
  }
}

# Worker routes need a proxied DNS record for the hostname to resolve. A
# discard AAAA proxied through Cloudflare is enough: the edge answers, the
# Access app enforces, and the Worker route serves before any origin is hit.
data "cloudflare_zone" "erfi" {
  count      = local.cf
  account_id = var.cf_account_id
  name       = var.cf_zone_name
}

resource "cloudflare_record" "proxy" {
  count   = local.cf
  zone_id = data.cloudflare_zone.erfi[0].id
  name    = var.cf_subdomain
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

# L11 gate: Access self-hosted app in front of the Worker hostname. The Worker
# is deployed with wrangler (see wrangler.jsonc); Access enforces at the edge
# before any request reaches it.
resource "cloudflare_zero_trust_access_application" "iap_proxy" {
  count                     = local.cf
  account_id                = var.cf_account_id
  name                      = "iap-lockdown proxy"
  type                      = "self_hosted"
  domain                    = local.proxy_hostname
  session_duration          = "24h"
  app_launcher_visible      = false
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.allow[0].id, cloudflare_zero_trust_access_policy.allow_svc[0].id]
  allowed_idps              = [var.cf_pin_idp_id]
}
