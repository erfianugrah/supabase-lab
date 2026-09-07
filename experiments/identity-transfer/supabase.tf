# One project, nothing else.
#
# The question: when an OAuth identity comes back with a NEW subject for an
# existing person (the shape an Apple Developer team transfer produces, where
# Apple's user identifier and private relay address are team-scoped), what does
# the managed Auth server do - link by verified email, create a second user,
# or follow a rewritten identity row? The provider slot is Keycloak because its
# issuer URL is a per-project setting the Auth server uses without an issuer
# check; the account-resolution code it feeds is shared by every provider,
# Apple included.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
