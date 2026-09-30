# One Medium project in Sydney, on the Team organisation.
#
# The shape under test is a shared multi-tenant production project reached
# from IPv4-only serverless functions through a pooler. Everything this
# experiment measures is an operation on this one project: the IPv4 add-on
# switch, a network restriction against the dedicated pooler, role-level
# timeouts through transaction pooling, what reaches the logs, a same-region
# read replica, a Medium -> Large resize, PgBouncer's CPU cost, and the
# client-connection ramp. Add-ons (ipv4, pitr) are applied by the modules
# through the Management API, not here: their application IS the measurement.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
