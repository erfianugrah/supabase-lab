output "project_ref" {
  description = "The consolidation target. Named project_ref because the harness Ctx expects that key, and the target is the subject of every test here."
  value       = supabase_project.shared.id
}

output "shared_ref" {
  value = supabase_project.shared.id
}

output "src_a_ref" {
  value = supabase_project.src_a.id
}

output "src_b_ref" {
  value = supabase_project.src_b.id
}

output "api_host" {
  value = "${supabase_project.shared.id}.supabase.co"
}
