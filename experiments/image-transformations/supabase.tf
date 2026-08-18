# One project, nothing else. Every question this experiment answers - which
# URL surfaces transform, where the documented limits disagree with the
# runtime, whether signed render URLs can be tampered with, whether the render
# path enforces storage RLS - is a property of the managed storage HTTP tier,
# so it needs no VPC, no endpoint, and no runner.
#
# Buckets and fixture objects are NOT tofu resources: the supabase provider
# has no bucket resource, and binary fixture uploads do not belong in
# restapi_object payloads. The I01 setup module creates them idempotently
# through the Storage API at run time - the same pattern edge-resilience
# uses for its drill fixtures.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
