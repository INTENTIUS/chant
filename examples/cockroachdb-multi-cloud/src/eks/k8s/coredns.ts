// K8s workloads: CoreDNS ConfigMap override for cross-cluster DNS forwarding.
// Forwards queries for crdb-aks.* and crdb-gke.* namespaces over VPN.

import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { CIDRS } from "../../shared/config";

// CoreDNS custom config to forward cross-cluster DNS queries.
// The kube-dns ClusterIP in each peer cluster resolves pod DNS names.
const corefile = `
crdb-aks.svc.cluster.local:53 {
    errors
    cache 30
    forward . ${CIDRS.aks.dnsIp}
}
crdb-gke.svc.cluster.local:53 {
    errors
    cache 30
    forward . ${CIDRS.gke.dnsIp}
}
`;

export const corednsCustomConfig = new ConfigMap({
  metadata: {
    name: "coredns-custom",
    namespace: "kube-system",
    labels: {
      "app.kubernetes.io/name": "coredns-custom",
      "app.kubernetes.io/managed-by": "chant",
      "app.kubernetes.io/component": "dns",
    },
  },
  data: {
    "crdb-forwarding.server": corefile.trim(),
  },
});
