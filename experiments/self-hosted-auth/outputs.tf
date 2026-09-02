output "project_ref" {
  value = supabase_project.lab.id
}

output "api_host" {
  value = "${supabase_project.lab.id}.supabase.co"
}
