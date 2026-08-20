# One project in Zurich. The residency doc's measured claims (edge PoP
# routing, function execution placement, the region catalogue) were taken
# against eu-central-1 from Singapore; re-measuring them against eu-central-2
# both re-checks the claims and confirms Zurich behaves as a first-class
# specific region.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
