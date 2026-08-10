output "project_ref" {
  description = "Named project_ref because the harness Ctx expects that key."
  value       = supabase_project.probe.id
}

output "api_host" {
  value = "${supabase_project.probe.id}.supabase.co"
}

output "region" {
  value = var.region
}

output "instance_size" {
  description = "Recorded so every latency measurement can carry the compute it was taken on."
  value       = var.instance_size
}
