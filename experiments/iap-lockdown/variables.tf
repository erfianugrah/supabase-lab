variable "supabase_access_token" {
  type      = string
  sensitive = true
}

variable "supabase_org_id" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "project_name" {
  type    = string
  default = "lab-iap-lockdown"
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

# --- Cloudflare (Phase B). Real values live in cloudflare.auto.tfvars, which
# is gitignored (*.tfvars); this repo is built to be public, so no account /
# zone / group ids are committed. ---
variable "cf_account_id" {
  type    = string
  default = ""
}

variable "cf_zone_name" {
  type    = string
  default = ""
}

# Zero Trust team domain (<team>.cloudflareaccess.com), used to build the
# Access-for-SaaS OIDC issuer URL.
variable "cf_team_domain" {
  type    = string
  default = ""
}

variable "cf_subdomain" {
  type    = string
  default = "iap-lab"
}

# Existing account-level identities (created in ~/cf-stuff), referenced by id
# so this experiment does not recreate or own them.
variable "cf_pin_idp_id" {
  type    = string
  default = ""
}

variable "cf_erfi_corp_group_id" {
  type    = string
  default = ""
}

# The email the L10d OIDC login authenticates as (must be an inbox the lab can
# read the one-time PIN from).
variable "cf_login_email" {
  type    = string
  default = ""
}

# Toggle so Phase A (Supabase only) can apply without the Cloudflare resources.
variable "enable_cloudflare" {
  type    = bool
  default = false
}
