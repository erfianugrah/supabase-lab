# Three projects, no AWS.
#
# The question is the direction the shared-tenancy guide does not cover: a
# platform that gave every end customer its own project wants ONE project with
# many tenants. Every runbook in the corpus goes the other way (shared ->
# dedicated, "promotion"), and merging is not promotion run backwards - two
# independently provisioned projects have two GoTrue instances that never
# coordinated on email uniqueness, and two schemas whose surrogate keys were
# both allocated from 1.
#
# So: two sources, one target. Two sources rather than one because every
# interesting failure here is a COLLISION, and a collision needs two
# independently generated values. A single source merged into an empty target
# is just a restore.
resource "supabase_project" "src_a" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-src-a"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "src_b" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-src-b"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "shared" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-shared"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
