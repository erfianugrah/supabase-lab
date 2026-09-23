# Two fresh projects on one Pro-plan org, one per app in the fixture monorepo.
#
# The question: when two Supabase projects are connected to the SAME GitHub
# repository, each with its own working directory (apps/a, apps/b), which
# pull requests create a preview branch on which project, with "Supabase
# changes only" on and off? And when both projects report a check on the same
# commit, can a CI job tell the two checks apart?
#
# The GitHub connection itself is NOT in this state: the Supabase GitHub App is
# installed and each project is connected from the dashboard (Project Settings
# -> Integrations -> GitHub). The provider has no resource for it.
resource "supabase_project" "a" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-a"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "b" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-b"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
