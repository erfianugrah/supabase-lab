# One project, nothing else. Phase A asks what the managed HTTP tier answers
# under each lockdown lever; that is a property of the tier, not of any
# network topology, so it needs no VPC, no endpoint, and no runner. Same
# reasoning as experiments/http-tier-lockdown.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
