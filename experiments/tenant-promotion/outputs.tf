output "project_ref" {
  description = "The source (shared) project. Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.shared.id
}

output "shared_ref" {
  value = supabase_project.shared.id
}

output "dedicated_ref" {
  value = supabase_project.dedicated.id
}

output "api_host" {
  value = "${supabase_project.shared.id}.supabase.co"
}