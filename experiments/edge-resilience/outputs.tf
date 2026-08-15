output "project_ref" {
  description = "Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.probe.id
}

output "api_host" {
  value = "${supabase_project.probe.id}.supabase.co"
}

output "standby_ref" {
  value = supabase_project.standby.id
}

output "standby_api_host" {
  value = "${supabase_project.standby.id}.supabase.co"
}
