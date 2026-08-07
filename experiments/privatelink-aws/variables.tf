variable "supabase_access_token" {
  description = "Supabase Management API PAT (secrets.tfvars)"
  type        = string
  sensitive   = true
}

variable "supabase_org_id" {
  description = "Supabase organization id"
  type        = string
}

variable "send_association" {
  description = "POST the PrivateLink association via /platform (requires a dashboard session JWT - PATs get 401). Default off; dashboard click + make arns is the normal trigger."
  type        = bool
  default     = false
}

variable "aws_account_id" {
  description = "AWS account that receives the RAM resource share"
  type        = string
}

variable "enable_ipv6" {
  description = "Give the VPC and private subnets IPv6, so a dualstack endpoint can be attempted (the IPv6-first-VPC question). Off by default - it changes the network every other test measures."
  type        = bool
  default     = false
}

variable "aws_access_key_id" {
  description = "AWS access key id. Empty = use the ambient chain (profile/SSO/env)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "aws_secret_access_key" {
  description = "AWS secret access key. Empty = use the ambient chain (profile/SSO/env)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "db_password" {
  description = "Postgres password for the lab project (secrets.tfvars)"
  type        = string
  sensitive   = true
}

variable "breakglass_cidr" {
  description = "Operator public IP /32, used as the break-glass allowlist entry"
  type        = string
}

variable "aws_region" {
  description = "AWS region - must match the Supabase project region (PrivateLink is same-region only)"
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  type    = string
  default = "lab-privatelink"
}

variable "instance_size" {
  description = "Supabase compute size. Tier only changes the pooler client ceiling (a published table), not connectivity/TLS/CLI behaviour - micro is enough for this matrix."
  type        = string
  default     = "micro"
}

variable "runner_instance_type" {
  type    = string
  default = "t3.micro"
}

variable "enable_lambda" {
  description = "Also deploy the test Lambda (requires `make lambda-zip` first)"
  type        = bool
  default     = false
}

variable "enable_second_vpc" {
  description = "T24: build a second VPC, peer it to the lab VPC, and associate the PHZ with it, to test whether a Resource endpoint is reachable across peering. Off by default - it is a second network surface with its own blast radius; opt in per live spin."
  type        = bool
  default     = false
}

variable "enable_service_network" {
  description = "T25: build a VPC Lattice service network, associate it with the lab VPC, and associate the project's resource configuration with it - the alternative consumption path to the direct Resource endpoint. Off by default - it bills a second per-resource-hour rate on top of the endpoint; opt in per live spin."
  type        = bool
  default     = false
}

variable "enable_transit_gateway" {
  description = "T27: route the second VPC to the lab VPC over a transit gateway (tgw.tf) instead of the peering connection T24 built. Mutually exclusive with that peering connection by construction - vpc2.tf tears peering down when this is on - so a client in the second VPC can only reach the endpoint one way at a time and T27 can attribute a reachable result to the transport actually under test. Off by default - a second, billed network surface; opt in alongside enable_second_vpc for a live spin that will run T27."
  type        = bool
  default     = false
}

variable "enable_read_replica" {
  description = "T28: create a read replica via the Management API (read-replicas/setup) and probe whether it appears as a second Lattice resource, gets its own hostname, and is reachable through the existing endpoint - removing it again in the test's own finally block. Also gates a second consumer Resource endpoint (replica.tf) for the replica's own resource configuration, once that ARN is known post-creation. Off by default - a replica bills for as long as it exists; opt in only for a live spin that will run T28 (with --destructive) to completion."
  type        = bool
  default     = false
}

variable "enable_soak" {
  description = "T29: an EventBridge schedule invoking the probe Lambda every few minutes, appending one JSON record per invocation to the suite bucket under soak/ (soak.tf) - a longer PgBouncer client-ceiling read than a single test run can take. Off by default - it accrues Lambda invocations and small S3 PUT costs for as long as it runs; opt in for a live spin, then read the accumulated records with T29."
  type        = bool
  default     = false
}

variable "public_access_cidrs" {
  description = "DB network restrictions allowlist. Default open; `make restrict IP=x.x.x.x` closes it to break-glass only for test T12."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

# Phase 2 values - produced by `make arns` into arns.tfvars after the
# PrivateLink association reaches READY and the RAM share exists.
variable "resource_share_arn" {
  type    = string
  default = ""
}

variable "resource_configuration_arn" {
  type    = string
  default = ""
}

# T28 phase 2: the read replica's own Lattice resource configuration ARN,
# once it exists and its RAM share has been accepted - same shape as
# resource_configuration_arn above, just for the replica instead of the
# primary. Empty by default - see aws_vpc_endpoint.read_replica in replica.tf.
variable "replica_resource_configuration_arn" {
  type    = string
  default = ""
}

locals {
  phase2 = var.resource_share_arn != "" && var.resource_configuration_arn != ""
  ref    = supabase_project.lab.id
  phz    = "db.${local.ref}.supabase.co"
}
