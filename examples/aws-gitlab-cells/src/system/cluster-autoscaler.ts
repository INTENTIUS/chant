// Cluster Autoscaler — scales the node group when pod scheduling pressure increases.
// Uses IRSA for IAM permissions.

import { Deployment, ServiceAccount } from "@intentius/chant-lexicon-k8s";
import { shared } from "../config";

const labels = {
  "app.kubernetes.io/name": "cluster-autoscaler",
  "app.kubernetes.io/part-of": "system",
  "app.kubernetes.io/managed-by": "chant",
};

export const autoscalerSa = new ServiceAccount({
  metadata: {
    name: "cluster-autoscaler-sa",
    namespace: "system",
    labels,
    annotations: {
      "eks.amazonaws.com/role-arn": shared.clusterAutoscalerRoleArn,
    },
  },
});

export const autoscaler = new Deployment({
  metadata: { name: "cluster-autoscaler", namespace: "system", labels },
  spec: {
    replicas: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "cluster-autoscaler" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "cluster-autoscaler" } },
      spec: {
        serviceAccountName: "cluster-autoscaler-sa",
        containers: [{
          name: "cluster-autoscaler",
          image: "registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0",
          command: [
            "./cluster-autoscaler",
            "--v=4",
            "--stderrthreshold=info",
            `--cloud-provider=aws`,
            `--skip-nodes-with-local-storage=false`,
            `--expander=least-waste`,
            `--node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/${shared.clusterName}`,
          ],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
        }],
      },
    },
  },
});
