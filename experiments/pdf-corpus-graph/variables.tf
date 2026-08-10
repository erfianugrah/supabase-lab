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
  default = "lab-pdf-corpus-graph"
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

# NOT micro, unlike most experiments here. Micro is the right default when the
# thing under test is an API shape, because compute cannot change whether an
# endpoint exists. Half of this experiment is latency and index-build time over
# a few hundred thousand rows, where a shared-CPU 1 GB instance measures the
# instance rather than the model - and the resulting numbers would be quoted at
# a corpus far larger than the one they were taken on.
#
# Medium (2 vCPU / 4 GB) is still small enough to read as a conservative floor:
# any traversal latency measured here is an upper bound for anything a real
# deployment would provision. Every measurement records the size alongside it so
# the caveat travels with the number.
variable "instance_size" {
  type    = string
  default = "medium"
}

# Unused here; the shared secrets.tfvars carries them and tofu rejects unknown
# values passed with -var-file.
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
