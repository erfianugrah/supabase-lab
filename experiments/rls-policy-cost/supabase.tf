# One project, nothing else. The questions this experiment answers - does
# (select auth.uid()) hoist, does an index collapse the wrap win, does a
# joined table inside EXISTS enforce its own RLS - are all properties of the
# Postgres planner and the RLS machinery, so they need one bare project and a
# direct SQL session, nothing more.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
