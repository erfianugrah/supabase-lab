# One disposable project. The experiment reproduces the supabase-flutter /
# gotrue-dart concurrent-refresh race (public tracker: supabase-flutter issues
# 895 and 930, unmerged PR 1309) against a live Auth server, then verifies the
# client-side fix. Nothing about the project itself is special - it only needs
# working email/password auth and token rotation defaults.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
