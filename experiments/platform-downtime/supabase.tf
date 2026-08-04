# One project, deliberately taken down in controlled ways.
#
# This experiment measures what a platform OPERATION costs a client, per
# connection path: restart, network-restriction flip, and (behind their own
# ids) resize. The interesting output is not a single duration but the shape -
# a REST caller and a pooler caller do not necessarily see the same outage, and
# the failure MODE decides how a real client behaves. A timeout burns the
# caller's whole budget on one attempt; a refusal returns immediately.
#
# Micro because the workload is a probe loop, not a benchmark. The compute size
# only matters here in that resize has to have somewhere to go.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
