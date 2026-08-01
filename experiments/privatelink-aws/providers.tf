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

# Credentials come from secrets.tfvars, same as the Supabase PAT - one
# encrypted source of truth. Provider-block creds are the highest-precedence
# entry in the AWS chain (verified: bogus keys here beat valid env vars), so
# a stale AWS_ACCESS_KEY_ID in the shell cannot break a run. Leave the vars
# empty to fall back to the ambient chain (profile / SSO / env) instead.
provider "aws" {
  region     = var.aws_region
  access_key = var.aws_access_key_id != "" ? var.aws_access_key_id : null
  secret_key = var.aws_secret_access_key != "" ? var.aws_secret_access_key : null
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
