# One Edge Function resource per slug, plus one optional secrets resource.
# tests/tf01-*.ts copies this directory to a scratch dir, writes
# terraform.tfvars.json and functions/<slug>/index.ts into it, and runs tofu
# there. Nothing in this file names a project.

variable "project_ref" {
  type = string
}

variable "slugs" {
  type    = list(string)
  default = []
}

variable "secrets" {
  type      = map(string)
  default   = {}
  sensitive = true
}

variable "manage_secrets" {
  type    = bool
  default = false
}

resource "supabase_edge_function" "fn" {
  for_each    = toset(var.slugs)
  project_ref = var.project_ref
  slug        = each.value
  name        = each.value
  entrypoint  = "${path.module}/functions/${each.value}/index.ts"
}

resource "supabase_edge_function_secrets" "s" {
  count       = var.manage_secrets ? 1 : 0
  project_ref = var.project_ref
  secrets = [
    for k, v in nonsensitive(var.secrets) : { name = k, value = v }
  ]
}
