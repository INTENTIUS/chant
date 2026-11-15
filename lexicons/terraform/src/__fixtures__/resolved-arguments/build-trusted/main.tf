locals {
  project_id    = "k8s-infra-prow-build-trusted"
  cluster_name  = "prow-build-trusted" // The name of the cluster defined in this file
  pod_namespace = "test-pods"
}

data "google_organization" "org" {
  domain = "kubernetes.io"
}

module "project" {
  source       = "../modules/gke-project"
  project_id   = local.project_id
  project_name = local.project_id
}

module "prow_build_cluster" {
  source          = "../modules/gke-cluster"
  project_name    = module.project.project_id
  cluster_name    = local.cluster_name
  is_prod_cluster = "true"
}
