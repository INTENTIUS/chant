import { createResource } from "@intentius/chant/runtime";
import { shared } from "../config";

const ClusterIssuer = createResource("K8s::CertManager::ClusterIssuer", "k8s", {});

// ClusterIssuer for Let's Encrypt — DNS-01 solver (HTTP-01 can't issue wildcards)
export const letsEncryptIssuer = new ClusterIssuer({
  metadata: { name: "letsencrypt-prod", namespace: "system" },
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
