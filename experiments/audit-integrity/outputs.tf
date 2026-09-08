output "project_ref" {
  description = "Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.probe.id
}

output "api_host" {
  value = "${supabase_project.probe.id}.supabase.co"
}

output "region" {
  value = supabase_project.probe.region
}

output "team_project_ref" {
  description = "Empty when no Team-plan org was supplied."
  value       = try(supabase_project.team[0].id, "")
}
