output "live_ref" {
  value = supabase_project.kit["live"].id
}

output "ready_ref" {
  value = supabase_project.kit["ready"].id
}

output "region" {
  value = var.region
}

# slug -> project ref for the self-service app backends (make new-app).
output "app_refs" {
  value = { for k, p in supabase_project.app : k => p.id }
}
