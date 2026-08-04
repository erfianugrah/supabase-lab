# Two projects, no AWS.
#
# The question: when a hub project's GoTrue is registered as a spoke project's
# third-party auth issuer and the hub rotates its signing key, does the spoke
# notice? The answer, measured three times in throwaway bash: it does not. Its
# cached kid set holds exactly the kid it resolved at trust-creation time, and
# a token signed by a key the spoke does not know about is rejected with
# PGRST301 even though the hub is now publishing that kid.
#
# `hub` plays the identity provider - its GoTrue issues the tokens and rotates
# its signing key. `spoke` trusts the hub via a third-party auth integration.
resource "supabase_project" "hub" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-hub"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "spoke" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-spoke"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
