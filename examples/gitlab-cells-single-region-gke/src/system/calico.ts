import { createResource } from "@intentius/chant/runtime";

const FelixConfiguration = createResource("K8s::Calico::FelixConfiguration", "k8s", {});

const systemLabels = { "app.kubernetes.io/part-of": "system" };

// GKE's Calico build names pod veth interfaces with the "gke" prefix
// (e.g. gke2d582428c84) rather than Calico's default "cali" prefix.
// Without this override Felix ignores all workload interfaces and writes
// zero iptables rules, making every NetworkPolicy a no-op.
export const felixConfiguration = new FelixConfiguration({
  metadata: { name: "default", labels: systemLabels },
  spec: {
    interfacePrefix: "gke",
  },
});
