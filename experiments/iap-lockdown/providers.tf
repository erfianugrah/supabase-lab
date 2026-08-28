terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.10"
    }
    # Cloudflare Access is the IAP (SaaS/OIDC issuer for L10, self-hosted gate
    # for L11). Pinned to v4 to match ~/cf-stuff/erfianugrah-cf-tf.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "supabase" {
  access_token = var.supabase_access_token
}

# Auth via env: CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY (v4 default credential
# chain). No Cloudflare secret is written to any tfvars file.
provider "cloudflare" {}
