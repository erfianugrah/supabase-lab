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

locals {
  phase2 = var.resource_share_arn != "" && var.resource_configuration_arn != ""
  ref    = supabase_project.lab.id
  phz    = "db.${local.ref}.supabase.co"
}
