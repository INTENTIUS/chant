import { createResource } from "@intentius/chant/runtime";
import { cells, shared } from "../config";

const ClusterIssuer = createResource("K8s::CertManager::ClusterIssuer", "k8s", {});
const Certificate = createResource("K8s::CertManager::Certificate", "k8s", {});

const systemLabels = { "app.kubernetes.io/part-of": "system" };

// ClusterIssuer for Let's Encrypt — DNS-01 solver (HTTP-01 can't issue wildcards)
export const letsEncryptIssuer = new ClusterIssuer({
  metadata: { name: "letsencrypt-prod", labels: systemLabels },
  spec: {
    acme: {
      server: "https://acme-v02.api.letsencrypt.org/directory",
      email: shared.letsEncryptEmail,
      privateKeySecretRef: { name: "letsencrypt-prod-key" },
      solvers: [{
        dns01: {
          cloudDNS: {
            project: shared.projectId,
          },
        },
      }],
    },
  },
});

// Wildcard TLS certificate for *.gitlab.intentius.io + per-cell wildcards (*.alpha.*, *.beta.*).
// Stored as secret "gitlab-tls" in system namespace; ingress-nginx uses it as default.
// cert-manager issues it via DNS-01 challenge against Cloud DNS.
// SAN list: base wildcard + per-cell wildcard (for chart-generated names like gitlab.alpha.*)
const perCellDnsNames = cells.map(c => `*.${c.name}.${shared.domain}`);
export const gitlabWildcardCert = new Certificate({
  metadata: { name: "gitlab-tls", namespace: "system", labels: systemLabels },
  spec: {
    secretName: "gitlab-tls",
    issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
    commonName: `*.${shared.domain}`,
    dnsNames: [
      `*.${shared.domain}`,
      shared.domain,
      ...perCellDnsNames,
    ],
  },
});
