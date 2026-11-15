data "google_organization" "org" {
  domain = "kubernetes.io"
}

resource "google_project" "project" {
  name       = var.project_name
  project_id = var.project_name
  org_id     = data.google_organization.org.org_id
}
