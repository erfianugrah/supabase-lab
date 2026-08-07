# One project, and an integration this repo cannot install.
#
# WHAT IS UNDER TEST. The Stripe Sync Engine integration copies Stripe objects
# into a `stripe` schema in your Postgres. It does that by projecting a schema
# from a Stripe OpenAPI spec, and the pin it projects from is recorded in
# `stripe._migrations`. Separately, it reads data through a managed webhook
# that pins no `api_version`, so payloads arrive at whatever version the Stripe
# ACCOUNT currently defaults to.
#
# Those two versions are independent and nothing reconciles them. When an
# account's version crosses a field relocation, a typed column can stop being
# populated while the value it used to hold reappears somewhere the projected
# schema has no column for. There is no error and no log line; a query that
# worked yesterday returns NULL today.
#
# WHY A DEDICATED PROJECT. This was first observed on a real project by
# accident, which is a bad instrument: its Stripe account has a narrow set of
# objects, all in similar states, so "this column is never populated" and
# "this column happens to be null for these fifteen rows" are
# indistinguishable. Telling real drift from a sampling artifact needs
# fixtures the observation project does not have - subscriptions that are
# trialing, past_due, canceled, multi-item, metered, discounted - and needs
# freedom to change the account's API version to watch the transition happen,
# which is not something to do to a project someone is presenting from.
#
# Micro because nothing here is a workload measurement: every probe is schema
# introspection over a few hundred rows.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
