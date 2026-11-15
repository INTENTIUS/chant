locals {
  workload_identity_service_accounts = {
    prow-build-trusted = {
      description = "default service account for pods in ${local.cluster_name}"
    }
    gcb-builder = {
      name        = "gcb-builder"
      description = "trigger GCB builds in all k8s-staging projects"
    }
    kubernetes-external-secrets = {
      description       = "sync K8s secrets from GSM in this and other projects"
      project_roles     = ["roles/secretmanager.secretAccessor"]
      cluster_namespace = "kubernetes-external-secrets"
    }
  }
}

module "workload_identity_service_accounts" {
  for_each          = local.workload_identity_service_accounts
  source            = "../modules/workload-identity-service-account"
  project_id        = module.project.project_id
  name              = each.key
  description       = each.value.description
  cluster_namespace = lookup(each.value, "cluster_namespace", local.pod_namespace)
  project_roles     = lookup(each.value, "project_roles", [])
}
