output "project_ref" {
  description = "App A's project. Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.a.id
}

output "project_b_ref" {
  description = "App B's project, passed to the battery as PVLAB_PEER_B."
  value       = supabase_project.b.id
}

output "region" {
  value = supabase_project.a.region
}
