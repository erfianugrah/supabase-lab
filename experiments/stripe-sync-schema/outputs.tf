output "project_ref" {
  description = "Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.probe.id
}

output "api_host" {
  value = "${supabase_project.probe.id}.supabase.co"
}

output "pooler_host" {
  description = "Pooler host. IPv4-reachable, unlike db.<ref>, which is IPv6-only from most laptops."
  value       = "aws-0-${var.region}.pooler.supabase.com"
}
