# One project, nothing else. The questions this experiment answers - is there
# a PAT-usable lever for the Data API toggle, and where does Realtime's
# private_only enforcement land - are properties of the managed HTTP tier, not
# of any network topology, so they need no VPC, no endpoint, and no runner.
#
# Kept out of experiments/privatelink-aws deliberately: that state is a
# ~20-minute build with a manual Dashboard step, and answering a config-flip
# question should not depend on it.
resource "supabase_project" "lab" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
