# One project, nothing else. The question is whether a GoTrue you run yourself
# can stand in for the managed Auth service on a managed project: share its
# auth schema, mint tokens the managed PostgREST trusts, and take over refresh.
# The self-hosted GoTrue is a local container started by the Makefile, not a
# tofu resource - it is the subject under test and lives for one probe run.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
