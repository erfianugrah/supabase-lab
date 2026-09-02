# One project, nothing else. Every question this experiment answers - which
# deploy path carries which size ceiling, which of the four secrets limits
# bites, whether a parallel deploy that reports success actually landed, and
# which documented restrictions hold at runtime - is a property of the managed
# Edge Functions control plane and runtime, so it needs no VPC and no runner.
#
# Functions and secrets are NOT tofu resources: they are the subject under
# test, created and deleted by the modules at run time so each module leaves
# the project as it found it. The plan-gated ceiling (functions per project)
# is read from organization entitlements, which needs no project at all.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
