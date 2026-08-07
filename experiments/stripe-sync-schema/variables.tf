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
  default = "lab-stripe-sync-schema"
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
#
# The Stripe key is deliberately NOT among them. Tofu has no use for it - only
# the fixture-seeding step does - and adding it to the shared secrets.tfvars
# would force a matching declaration into all nine other experiments. It
# arrives as STRIPE_SECRET_KEY in the environment instead.
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
