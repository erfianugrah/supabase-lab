# Two projects, no AWS.
#
# The question: when an app moves from one Supabase project to another, what
# does it take for sessions that already exist to survive? The plan
# under test is "import one signing key into both projects, copy the auth schema,
# pin storageKey". Each of those carries a different part of a session, so
# the experiment needs two projects whose signing keys and auth rows it can
# control independently - and nothing else.
#
# `source` is the project the app is moving OFF. `target` is where it lands.
resource "supabase_project" "source" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-source"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "target" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-target"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
