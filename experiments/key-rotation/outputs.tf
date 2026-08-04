output "project_ref" {
  description = "The hub. Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.hub.id
}

output "hub_ref" {
  value = supabase_project.hub.id
}

output "spoke_ref" {
  value = supabase_project.spoke.id
}

output "api_host" {
  value = "${supabase_project.hub.id}.supabase.co"
}
