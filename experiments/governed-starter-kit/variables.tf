variable "supabase_access_token" {
  type      = string
  sensitive = true
}

# Must be a Team (or Enterprise) plan org for the access-control features the
# kit demonstrates. The shared secrets.tfvars default is the lab's Team org.
variable "supabase_org_id" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

# role -> project name. The Makefile reads the refs back by role.
variable "projects" {
  type = map(string)
  default = {
    live  = "kit-live"
    ready = "kit-ready"
  }
}

# Extra app backends requested through `make new-app NAME=<slug>`. Written to
# apps.auto.tfvars by the Makefile; empty by default.
variable "extra_apps" {
  type    = set(string)
  default = []

  validation {
    condition     = alltrue([for n in var.extra_apps : can(regex("^[a-z][a-z0-9-]{0,19}$", n))])
    error_message = "extra_apps entries must be lowercase slugs: a letter, then up to 19 of a-z, 0-9, -."
  }
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
