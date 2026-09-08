# One project. The whole experiment is about which verifier trusts which token:
# an in-process ES256 key stands in for an external identity provider, its JWKS
# is published from an Edge Function on this project and registered as
# third-party auth, and the modules ask whether the data API trusts its tokens,
# whether RLS reads its claims, and whether GoTrue and its migrations persist
# alongside it. No VPC, no runner, no container - the "external IdP" is a signer
# in the test process.
#
# The issuer registration, the JWKS function, tables, policies and users are NOT
# tofu resources: the modules create and delete them at run time so each leaves
# the project as it found it.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
