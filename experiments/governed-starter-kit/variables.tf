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
