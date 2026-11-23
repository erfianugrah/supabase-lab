# One project in ap-southeast-1. The flow under test (front Worker -> Edge
# Function -> mTLS/JWT upstream) needs nothing else on the Supabase side.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
