# Two projects, nothing else.
#
# The question: can one project's identity be trusted by another, so a tenant's
# token survives being moved between projects? That is a property of the auth
# tier's third-party trust configuration, so it needs two projects and no VPC,
# no endpoint, no runner.
#
# `hub` plays the identity provider - its GoTrue issues the tokens. `spoke`
# plays a tenant's own project, configured to trust the hub. The names avoid
# "shared"/"dedicated" because the trust question is independent of whichever
# tenancy model sits on top of it.
resource "supabase_project" "hub" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-hub"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "spoke" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-spoke"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
