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

# T24 - the function name (not a full CLI command, unlike lambda_invoke above)
# because the test passes it straight to invokeProbe's functionName param via
# ctx.endpoints.second_vpc_lambda.
output "second_vpc_lambda_name" {
  value = var.enable_second_vpc && var.enable_lambda ? aws_lambda_function.probe_second_vpc[0].function_name : ""
}

# T25 - the Lattice-generated DNS name for the service-network resource
# association, once phase 2 has run. Empty until then, same as endpoint_dns.
output "service_network_dns" {
  value = var.enable_service_network && local.phase2 ? try(aws_vpclattice_service_network_resource_association.supabase[0].dns_entry[0].domain_name, "") : ""
}
