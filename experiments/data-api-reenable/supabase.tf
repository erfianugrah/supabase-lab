# One project. The question is how long the Data API takes to serve again
# after it is switched back on, and what a client can poll to know it has.
# Both are properties of the managed HTTP tier, so no VPC and no runner.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
