# One project, nothing else. The question - can a Supabase project stand in for
# a static host the way Cloudflare Pages or Netlify do - is a property of the
# managed Storage and Edge Functions HTTP surfaces, so it needs no VPC and no
# runner.
#
# The bucket, its objects and the file-server function are NOT tofu resources:
# they are the subject under test, created by the modules at run time. Objects
# stay in the bucket after a run; the project is destroyed after the battery.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
