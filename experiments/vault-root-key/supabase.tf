# Two projects, no AWS. The question is whether a Vault secret survives being
# carried to a different project - the one item in the migration guides with
# no recovery path if it is wrong.
#
# `source` holds the secrets and owns the pgsodium root key. `target` plays the
# project a region move or a restore lands you on: same rows, different key.
#
# The interesting measurement is the NEGATIVE one (V02): ciphertext copied
# without the key must fail to decrypt. If that passes silently, every claim
# about the root key mattering is wrong, and the tests that follow are moot.
#
# Deliberately separate resources rather than count/for_each: `make
# probe-deleted-source` destroys ONLY the source, with -target, to open the
# post-deletion window V04 measures. A counted resource makes that targeting
# read as an index and the intent disappears.
resource "supabase_project" "source" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-source"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}

resource "supabase_project" "target" {
  organization_id   = var.supabase_org_id
  name              = "${var.project_name}-target"
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
