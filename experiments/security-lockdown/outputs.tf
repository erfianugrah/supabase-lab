output "project_ref" {
  value = supabase_project.lab.id
}

output "api_host" {
  value = "${supabase_project.lab.id}.supabase.co"
}

# Direct Postgres host (IPv6). S04 (self-hosted PostgREST) connects via the
# pooler instead; the pooler host is resolved at run time from the Management
# API, since its shape (aws-0-<region>.pooler.supabase.com) is not in tofu.
output "db_host" {
  value = "db.${supabase_project.lab.id}.supabase.co"
}

output "region" {
  value = var.region
}
