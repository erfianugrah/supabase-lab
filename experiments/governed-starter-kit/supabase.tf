# Two projects in the Team-plan org, both throwaway:
#
#   live  - the project a coding agent builds on during a walkthrough. Gets only
#           the kit baseline (sql/00-baseline.sql), so the app schema is the
#           agent's to write.
#   ready - the same kit with the example app and the in-app agent schema
#           already applied (sql/10-app.sql, sql/20-agent.sql). It is the
#           fallback if the live build stalls, and the target the RLS matrix
#           test runs against.
#
# A Team org rather than Pro because the access-control half of the kit -
# project-scoped roles, the Read-only role, platform audit logs - only exists
# on Team and above. Member and role assignment has no Management API on Pro or
# Team (supabase-org-topology measured it), so those stay a manual dashboard
# step and are not modelled here.
resource "supabase_project" "kit" {
  for_each = var.projects

  organization_id   = var.supabase_org_id
  name              = each.value
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
