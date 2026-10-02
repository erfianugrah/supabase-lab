# One micro project; every TLS surface it exposes is the subject.
#
# The HTTP edge (<ref>.supabase.co, the Storage host, the legacy functions
# host), the shared pooler, and - once TL14 adds the IPv4 add-on - direct
# 5432 and the dedicated PgBouncer. Micro because nothing here is a workload:
# a TLS handshake does not depend on compute size. Add-ons (ipv4,
# custom_domain) and SSL enforcement are applied by the modules through the
# Management API, because applying them is part of what is measured.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
