# Two projects, no AWS.
#
# The question: when a tenant is promoted from a shared project to its own
# dedicated one, does the client that learns its placement at runtime follow
# without re-authenticating? That is a property of the auth tier's token
# portability plus the mechanism that copies the identity rows, so it needs
# two projects and no VPC, no endpoint, no runner.
#
# `shared` plays the starting tier - the project a tenant is promoted OUT of.
# `dedicated` plays the destination - the tenant's own project.
resource "supabase_project" "shared" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-shared"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "dedicated" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-dedicated"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}