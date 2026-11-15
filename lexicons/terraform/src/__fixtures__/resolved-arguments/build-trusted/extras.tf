resource "google_storage_bucket" "from_data" {
  name     = "${data.google_organization.org.org_id}-artifacts"
  location = "US"
}

resource "google_storage_bucket" "dated" {
  name     = "logs-${timestamp()}"
  location = "US"
}

resource "google_project_iam_member" "computed" {
  project = module.project.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${module.workload_identity_service_accounts["gcb-builder"].email}"
}

module "canary_cluster" {
  source          = "../modules/gke-cluster"
  project_name    = local.project_id
  cluster_name    = "${local.cluster_name}-canary"
  is_prod_cluster = "false"
}

resource "google_storage_bucket" "compared" {
  count    = local.project_id != "" ? 1 : 0
  name     = data.google_organization.org.org_id == "" ? "a" : "b"
  location = "US"
}
