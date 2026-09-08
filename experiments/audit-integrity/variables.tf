variable "supabase_access_token" {
  type      = string
  sensitive = true
}

variable "supabase_org_id" {
  type = string
}

# A Team-plan org, when one is available. The plan-gated half of this
# experiment lives here: platform audit logs (security.audit_logs_days is 0 and
# no-access on Pro, 62 days on Team), audit log drains, and the Read-Only and
# project-scoped member roles. Empty means "skip the Team-plan project".
variable "team_org_id" {
  type    = string
  default = ""
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "project_name" {
  type    = string
  default = "lab-audit-integrity"
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "instance_size" {
  type    = string
  default = "micro"
}

# Unused here, but the shared secrets.tfvars carries them and tofu rejects
# unknown values passed with -var-file.
variable "aws_account_id" {
  type    = string
  default = ""
}

variable "aws_access_key_id" {
  type    = string
  default = ""
}

variable "aws_secret_access_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "breakglass_cidr" {
  type    = string
  default = ""
}
