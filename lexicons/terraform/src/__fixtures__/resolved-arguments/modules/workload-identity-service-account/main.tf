locals {
  description = var.description != "" ? var.description : var.name
}

resource "google_service_account" "serviceaccount" {
  project      = var.project_id
  account_id   = var.name
  display_name = local.description
}

resource "google_project_iam_member" "project_roles" {
  for_each = toset(var.project_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.serviceaccount.email}"
}
