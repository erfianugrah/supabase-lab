terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.10"
    }
  }
}

provider "supabase" {
  access_token = var.supabase_access_token
}
