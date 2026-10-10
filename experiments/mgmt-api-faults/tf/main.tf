# Minimal config for the fault-injection runs: one project plus its settings.
# The provider endpoint is the local fault proxy, so every call the provider
# makes passes through it. Local state only (the module runs in a scratch dir).
terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.10"
    }
  }
}

variable "endpoint" {
  type        = string
  description = "Management API base URL; the fault proxy."
}

variable "access_token" {
  type      = string
  sensitive = true
}

variable "org_id" {
  type = string
}

variable "project_name" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "enable_settings" {
  type    = bool
  default = false
}

variable "max_rows" {
  type    = number
  default = 1000
}

provider "supabase" {
  access_token = var.access_token
  endpoint     = var.endpoint
}

resource "supabase_project" "t" {
  organization_id   = var.org_id
  name              = var.project_name
  database_password = var.db_password
  region            = "ap-southeast-1"
}

resource "supabase_settings" "t" {
  count       = var.enable_settings ? 1 : 0
  project_ref = supabase_project.t.id

  api = jsonencode({
    db_schema            = "public,storage"
    db_extra_search_path = "public,extensions"
    max_rows             = var.max_rows
  })
}
