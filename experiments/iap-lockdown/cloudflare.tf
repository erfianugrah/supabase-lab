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
    auth_type     = "oidc"
    redirect_uris = local.proxy_callback_uris
    grant_types   = ["authorization_code_with_pkce"]
    scopes        = ["openid", "email", "profile", "groups"]
  }
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
  policies                  = [cloudflare_zero_trust_access_policy.allow[0].id]
  allowed_idps              = [var.cf_pin_idp_id]
}
