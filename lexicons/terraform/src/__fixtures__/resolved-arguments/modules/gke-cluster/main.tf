resource "google_container_cluster" "prod_cluster" {
  count = var.is_prod_cluster == "true" ? 1 : 0

  name     = var.cluster_name
  location = "us-central1"
  project  = var.project_name
}
