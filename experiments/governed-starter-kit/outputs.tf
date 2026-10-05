output "live_ref" {
  value = supabase_project.kit["live"].id
}

output "ready_ref" {
  value = supabase_project.kit["ready"].id
}

output "region" {
  value = var.region
}
