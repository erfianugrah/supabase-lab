output "project_ref" {
  description = "The source. Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.source.id
}

output "source_ref" {
  value = supabase_project.source.id
}

output "target_ref" {
  value = supabase_project.target.id
}

output "api_host" {
  value = "${supabase_project.source.id}.supabase.co"
}
