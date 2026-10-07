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

# Self-service backends: one more guarded project per requested app, same org,
# region and size as the pair above. `make new-app NAME=<slug>` adds the slug
# to apps.auto.tfvars (gitignored, read automatically by tofu) and applies;
# `make remove-app NAME=<slug>` takes it out again. Because the request list
# lives in a var-file every plan reads, a plain `make apply` keeps these
# projects instead of planning to destroy them. A separate resource rather
# than more keys in var.projects, so the app list never feeds the for_each
# that holds kit-live and kit-ready; the Makefile also refuses any app plan
# that touches anything but the one app.
resource "supabase_project" "app" {
  for_each = var.extra_apps

  organization_id   = var.supabase_org_id
  name              = "kit-app-${each.key}"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
