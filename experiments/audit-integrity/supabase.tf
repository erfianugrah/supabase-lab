# One fresh project, nothing else.
#
# The question: on a managed project the tenant administers, who can erase the
# audit trail, what trace does erasing it leave, and which copy of an auth event
# survives a tenant with the database password? A FRESH project is the point -
# every privilege, grant and logging default measured here has to be a platform
# default rather than something an older project drifted into.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

# The same probe project on a Team-plan org, so the plan-gated surfaces are
# measurable rather than inferred from an entitlement number. Two projects in
# one state rather than two applies: the battery points at either one with
# `make probe ORG=team`, and the database-side facts can be compared across
# plans in the same run window.
resource "supabase_project" "team" {
  count             = var.team_org_id == "" ? 0 : 1
  organization_id   = var.team_org_id
  name              = "${var.project_name}-team"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
