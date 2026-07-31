output "project_ref" {
  value = local.ref
}

output "phz_host" {
  value = local.phz
}

output "runner_id" {
  value = aws_instance.runner.id
}

output "ssm_connect" {
  value = "aws ssm start-session --target ${aws_instance.runner.id} --region ${var.aws_region}"
}

output "endpoint_ips" {
  value = local.phase2 ? [for eni in data.aws_network_interface.endpoint : eni.private_ip] : []
}

output "endpoint_dns" {
  value = local.phase2 ? try(aws_vpc_endpoint.supabase[0].dns_entry[0].dns_name, "unavailable - use IPs or console") : ""
}

output "lambda_invoke" {
  value = var.enable_lambda ? "aws lambda invoke --function-name supabase-lab-probe --region ${var.aws_region} /dev/stdout" : "lambda disabled"
}
