terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.10"
    }
  }
}

# The access token comes from SUPABASE_ACCESS_TOKEN in the environment, so it
# never lands in a var file or in state.
provider "supabase" {}
