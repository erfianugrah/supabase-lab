# One project, probed through failure-injection tokens and an edge cache.
#
# This experiment measures what a CLIENT can do about platform-side incidents
# that are not theirs to fix: JWT claim-validation rejections (the
# future-iat/PGRST303 class), retry behaviour of the official client, and
# stale reads served from an edge cache while the origin is down. The project
# is the target, not the variable - micro is enough because the workload is a
# probe loop.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

# Standby for the cutover drills (W05, W09, W10, W11, W15, W16, W17, W22).
# Different region because the drill is
# about surviving a regional/platform event, not a single-project one. The
# module measures whether managed->managed logical replication is even
# possible (pooler cannot stream WAL; direct host is IPv6-only by default).
resource "supabase_project" "standby" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-standby"
  database_password = var.db_password
  region            = var.standby_region
  instance_size     = var.standby_instance_size
}
