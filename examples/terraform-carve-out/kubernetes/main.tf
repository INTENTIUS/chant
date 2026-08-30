# A Terraform estate that manages Kubernetes objects through the kubernetes
# provider — the second carve target, alongside the AWS estate next door.
#
# `kubernetes_manifest` is the generic one: the body IS the object, so the same
# carve rule covers a core ConfigMap and a cert-manager Certificate. The typed
# provider resources (`kubernetes_config_map` and friends) reshape the object
# into the provider's own schema, so they rank but do not emit yet.

resource "kubernetes_namespace" "web" {
  metadata {
    name = "web"
  }
}

# Clean leaf: a ConfigMap declared as a manifest, in the namespace above.
resource "kubernetes_manifest" "app_config" {
  manifest = {
    apiVersion = "v1"
    kind       = "ConfigMap"
    metadata = {
      name      = "app-config"
      namespace = kubernetes_namespace.web.metadata[0].name
    }
    data = {
      LOG_LEVEL = "info"
    }
  }
}

# A CRD the lexicon ships no generated class for. Carves through the same rule:
# apiVersion and kind come out of the body, so nothing here is cert-manager
# specific.
resource "kubernetes_manifest" "web_cert" {
  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "Certificate"
    metadata = {
      name      = "web-tls"
      namespace = "web"
    }
    spec = {
      secretName = "web-tls"
      dnsNames   = ["web.example.com"]
      issuerRef = {
        name = "letsencrypt"
        kind = "ClusterIssuer"
      }
    }
  }
}

# Typed provider resource: ranked tier 2, refused by emit — recovering the
# object from the provider schema is a per-type reshaping.
resource "kubernetes_config_map" "legacy" {
  metadata {
    name      = "legacy"
    namespace = "web"
  }
  data = {
    OLD = "true"
  }
}
