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
  default = "lab-medium-serverless"
}

# Sydney on purpose: the shape under test is an IPv4-only serverless client
# (Vercel) in front of a Medium project in ap-southeast-2. Region is one var so
# the same battery runs anywhere.
variable "region" {
  type    = string
  default = "ap-southeast-2"
}

# Medium is the first size this battery has run on. Every earlier pooler and
# downtime number in this repo is Micro or Small.
variable "instance_size" {
  type    = string
  default = "medium"
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
