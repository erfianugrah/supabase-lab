output "project_ref" {
  value = supabase_project.lab.id
}

output "api_host" {
  value = "${supabase_project.lab.id}.supabase.co"
}

# The pooler host shape (aws-0-<region>.pooler.supabase.com) is not a tofu
# resource; the Makefile builds it from this output at run time.
output "region" {
  value = var.region
}
