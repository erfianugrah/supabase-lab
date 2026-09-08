# One project, nothing else. Every question here - which lock mode a foreign
# key to auth.users takes, whether NOT VALID + VALIDATE avoids it, and whether
# an idle-in-transaction session blocks a migration-shaped ALTER - is a
# property of Postgres and the platform's auth schema, measured through two
# connections plus a live sign-in. No VPC, no runner.
#
# The public tables the modules create (public.al_*), the foreign keys, and any
# seeded user are NOT tofu resources: they are the subject under test, created
# and dropped by the modules at run time so each leaves the project as it found
# it. auth.users DDL itself is platform-restricted, so the migration-shaped
# ALTER is modelled on a public table - see AL03's module doc.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
