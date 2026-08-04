# One project, read-only probes against it.
#
# This experiment does not test a behaviour - it harvests the platform
# constants that the docs quote as bare numbers: compute prices, connection
# counts, key shapes, per-plan entitlements, the default Postgres major. Those
# are the most staleness-prone class of claim in the corpus and the cheapest
# to re-measure, so this is built to be re-run on a schedule and DIFFED
# against the previous run, not run once.
#
# The project has to exist because most of the surface is project-scoped
# (billing/addons, api-keys, signing-keys, health). Micro because the values
# being read are catalogue entries, not workload measurements.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
