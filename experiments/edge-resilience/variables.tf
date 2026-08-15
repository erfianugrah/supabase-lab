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
  default = "lab-edge-resilience"
}

variable "region" {
  type    = string
  default = "ap-southeast-2"
}

variable "instance_size" {
  type    = string
  default = "micro"
}

variable "standby_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "standby_instance_size" {
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
