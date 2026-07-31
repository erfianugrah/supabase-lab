terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.10"
    }
    # Mastercard/restapi - full CRUD against REST APIs. Used for the PrivateLink
    # association endpoints, which are NOT in the supabase provider and NOT in
    # the published /v1 Management API spec (discovered from Studio source:
    # apps/studio/data/aws-accounts/). NOTE: hashicorp/http is GET-only and
    # cannot do this.
    restapi = {
      source  = "mastercard/restapi"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "supabase" {
  access_token = var.supabase_access_token
}

provider "restapi" {
  uri           = "https://api.supabase.com"
  create_method = "POST"
  update_method = "PATCH"
  headers = {
    Authorization = "Bearer ${var.supabase_access_token}"
    Content-Type  = "application/json"
  }
}
