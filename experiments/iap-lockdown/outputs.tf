output "project_ref" {
  value = supabase_project.lab.id
}

output "api_host" {
  value = "${supabase_project.lab.id}.supabase.co"
}

# Cloudflare (empty unless enable_cloudflare=true). oidc_issuer_url is what
# L10 registers as Supabase third-party auth.
# The OIDC issuer is <team-domain>/cdn-cgi/access/sso/oidc/<client_id>. The v4
# provider leaves the resource `domain` attribute empty for SaaS apps, so build
# it from the client_id (verified live against the discovery endpoint).
output "oidc_issuer_url" {
  value = var.enable_cloudflare ? "https://${var.cf_team_domain}/cdn-cgi/access/sso/oidc/${cloudflare_zero_trust_access_application.iap_issuer[0].saas_app[0].client_id}" : ""
}

output "oidc_client_id" {
  value = var.enable_cloudflare ? cloudflare_zero_trust_access_application.iap_issuer[0].saas_app[0].client_id : ""
}

output "oidc_client_secret" {
  value     = var.enable_cloudflare ? cloudflare_zero_trust_access_application.iap_issuer[0].saas_app[0].client_secret : ""
  sensitive = true
}

output "proxy_hostname" {
  value = var.enable_cloudflare ? local.proxy_hostname : ""
}

# Access service token for the M2M call to the proxy (L12). client_secret is
# only returned by the API at create time; keep it out of anything committed.
output "svc_token_client_id" {
  value = var.enable_cloudflare ? cloudflare_zero_trust_access_service_token.l12[0].client_id : ""
}

output "svc_token_client_secret" {
  value     = var.enable_cloudflare ? cloudflare_zero_trust_access_service_token.l12[0].client_secret : ""
  sensitive = true
}

