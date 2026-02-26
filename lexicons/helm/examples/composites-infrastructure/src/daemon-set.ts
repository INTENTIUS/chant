import { HelmDaemonSet } from "@intentius/chant-lexicon-helm";

export const { chart, values, daemonSet, serviceAccount } = HelmDaemonSet({
  name: "log-collector",
  imageRepository: "fluent/fluent-bit",
  imageTag: "3.0",
  hostPaths: [
    { name: "varlog", hostPath: "/var/log", mountPath: "/var/log", readOnly: true },
    { name: "containers", hostPath: "/var/lib/docker/containers", mountPath: "/var/lib/docker/containers", readOnly: true },
  ],
});
