# One project. No AWS.
#
# WHAT IS UNDER TEST. A recurring evaluation shape: an organisation holds a
# large corpus of unstructured public PDFs and wants it to become a structured,
# queryable database - entities and the relationships between them - so that
# tooling built on top can ask "who is connected to whom". The question put to
# Postgres/Supabase is whether it can be the destination and the query layer for
# that, and the question put to this experiment is which parts of that are
# assertions from documentation and which are measured facts.
#
# WHY IT NEEDS A LIVE PROJECT. The available answer today is a documentation
# search returning zero hits for graph and PDF capability. That is evidence of
# absence in the docs, which is not the same claim as absence in the platform,
# and it is exactly the negative this repo has been wrong about before
# (platform-facts F05: an earlier investigation concluded an API could not do a
# thing after probing only the paths named after it). Three specific questions
# only a live project can answer:
#
#   1. Does the managed Postgres actually offer a graph engine? The extension
#      CATALOGUE is the platform's own answer, and it outranks a doc grep in
#      both directions - it can surface something the docs never wrote up, and
#      its silence is authoritative rather than editorial.
#   2. Can an Edge Function parse a PDF at all, and where does it stop? The
#      honest position is that extraction is customer-owned code, but "you
#      write it, and here is the measured ceiling when it runs on our runtime"
#      is a different and much more useful sentence than "not supported".
#   3. What does the extracted output actually WEIGH per source megabyte? Every
#      cost projection for a corpus this size currently rests on a guessed
#      expansion ratio, which makes the projection unfalsifiable. One real
#      corpus run replaces the guess with a measurement.
#
# Nothing here is engagement-specific: the corpus is public documents fetched at
# run time, and the graph fixture is generated.
resource "supabase_project" "probe" {
  organization_id   = var.supabase_org_id
  name              = var.project_name
  database_password = var.db_password
  region            = var.region
  instance_size     = var.instance_size
}
