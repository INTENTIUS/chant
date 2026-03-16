import {
  Namespace,
  ServiceAccount,
  Role,
  RoleBinding,
} from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "app-team";
const labels = { "app.kubernetes.io/name": "app-team" };

export const namespace = new Namespace({
  metadata: {
    name: NAMESPACE,
    labels,
  },
});

export const serviceAccount = new ServiceAccount({
  metadata: {
    name: "app-team-sa",
    namespace: NAMESPACE,
    labels,
  },
});

export const podReaderRole = new Role({
  metadata: {
    name: "pod-reader",
    namespace: NAMESPACE,
    labels,
  },
  rules: [
    {
      apiGroups: [""],
      resources: ["pods", "pods/log"],
      verbs: ["get", "list", "watch"],
    },
  ],
});

export const podReaderBinding = new RoleBinding({
  metadata: {
    name: "pod-reader-binding",
    namespace: NAMESPACE,
    labels,
  },
  roleRef: {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "Role",
    name: "pod-reader",
  },
  subjects: [
    {
      kind: "ServiceAccount",
      name: "app-team-sa",
      namespace: NAMESPACE,
    },
  ],
});
