resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.aws_region
  instance_size     = var.instance_size
}

# Network restrictions (the "close public access" test, T12). Default is
# fully open; `make restrict IP=x.x.x.x` narrows it to the break-glass IP.
# The settings resource manages per-category JSON blobs - first apply also
# verifies this does not clobber other project settings.
resource "supabase_settings" "lab" {
  project_ref = supabase_project.lab.id
  network = jsonencode({
    restrictions = var.public_access_cidrs
  })
}

# PrivateLink association: registers the AWS account with the project, which
# makes Supabase create the VPC Lattice Resource Configuration and send the
# RAM resource share. Endpoint discovered from Studio source
# (apps/studio/data/aws-accounts/); NOT in the published /v1 spec.
#
# AUTH FINDING (run 2 + run 3, 2026-07-31): this endpoint rejects PATs with
# 401 {"message":"JWT could not be decoded"} - verified with both a
# Developer-role PAT and an Owner-role PAT, and `supabase login` tokens are
# the same sbp_ type. It requires a dashboard session JWT. The resource is
# therefore gated behind var.send_association (default false); the normal
# flow is one dashboard click (Settings > Integrations > AWS PrivateLink)
# and `make arns` picks the share up from the AWS side.
#
# Status lifecycle (from Studio's AWSAccount type):
#   CREATING -> READY -> ASSOCIATION_ACCEPTED
#   CREATION_FAILED is the state a new-VPC-generation block would
#   surface as - `make wait-ready` watches for exactly this (needs a session
#   JWT in SUPABASE_ACCESS_TOKEN, a PAT gets 401).
#
# Destroy semantics verified from Studio source: DELETE .../aws-account/{aws_account_id},
# which matches restapi_object's default destroy of DELETE {path}/{id} exactly.
resource "restapi_object" "privatelink_aws_account" {
  count = var.send_association ? 1 : 0
  path         = "/platform/projects/${supabase_project.lab.id}/privatelink/associations/aws-account"
  id_attribute = "aws_account_id"

  data = jsonencode({
    aws_account_id = var.aws_account_id
    account_name   = "supabase-lab"
  })
}
