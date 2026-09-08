# One project. The rate limits, the email-send cap on the built-in provider,
# IP-address forwarding, and the bcrypt-bound sign-up latency curve are all
# properties of the managed GoTrue in front of this project. No VPC, no runner.
#
# Users (anonymous and admin-created) are NOT tofu resources: the modules
# create them at run time and delete them in finally, so each leaves the
# project as it found it. Auth config is PATCHed and restored per module.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
