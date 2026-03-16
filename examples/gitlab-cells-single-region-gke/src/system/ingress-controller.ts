import {
  Deployment, Service, ConfigMap, PodDisruptionBudget, HorizontalPodAutoscaler,
  ServiceAccount, ClusterRole, ClusterRoleBinding, Role, RoleBinding, IngressClass,
} from "@intentius/chant-lexicon-k8s";
import { shared } from "../config";

const labels = {
  "app.kubernetes.io/name": "ingress-nginx-controller",
  "app.kubernetes.io/part-of": "system",
};

// ServiceAccount the controller runs as
export const ingressServiceAccount = new ServiceAccount({
  metadata: { name: "ingress-nginx", namespace: "system", labels },
});

// ClusterRole: read-only access to cluster-wide resources the controller watches
export const ingressClusterRole = new ClusterRole({
  metadata: { name: "ingress-nginx", labels },
  rules: [
    { apiGroups: [""], resources: ["configmaps", "endpoints", "nodes", "pods", "secrets", "namespaces"], verbs: ["list", "watch"] },
    { apiGroups: [""], resources: ["nodes"], verbs: ["get"] },
    { apiGroups: [""], resources: ["services"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "list", "watch"] },
    { apiGroups: [""], resources: ["events"], verbs: ["create", "patch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["ingresses/status"], verbs: ["update"] },
    { apiGroups: ["networking.k8s.io"], resources: ["ingressclasses"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["list", "watch", "get"] },
    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["list", "watch"] },
  ],
});

export const ingressClusterRoleBinding = new ClusterRoleBinding({
  metadata: { name: "ingress-nginx", labels },
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "ingress-nginx" },
  subjects: [{ kind: "ServiceAccount", name: "ingress-nginx", namespace: "system" }],
});

// Role: namespace-scoped permissions for leader election and configmap updates
export const ingressRole = new Role({
  metadata: { name: "ingress-nginx", namespace: "system", labels },
  rules: [
    { apiGroups: [""], resources: ["namespaces"], verbs: ["get"] },
    { apiGroups: [""], resources: ["configmaps", "pods", "secrets", "endpoints"], verbs: ["get", "list", "watch"] },
    { apiGroups: [""], resources: ["services"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["ingresses", "ingressclasses"], verbs: ["get", "list", "watch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["ingresses/status"], verbs: ["update"] },
    { apiGroups: [""], resources: ["configmaps"], resourceNames: ["ingress-nginx-leader"], verbs: ["get", "update"] },
    { apiGroups: [""], resources: ["configmaps"], verbs: ["create"] },
    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: ["ingress-nginx-leader"], verbs: ["get", "update"] },
    { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["create"] },
    { apiGroups: [""], resources: ["events"], verbs: ["create", "patch"] },
    { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["list", "watch", "get"] },
  ],
});

export const ingressRoleBinding = new RoleBinding({
  metadata: { name: "ingress-nginx", namespace: "system", labels },
  roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "ingress-nginx" },
  subjects: [{ kind: "ServiceAccount", name: "ingress-nginx", namespace: "system" }],
});

// IngressClass so the controller is recognized as the default ingress provider
export const nginxIngressClass = new IngressClass({
  metadata: {
    name: "nginx",
    labels,
    annotations: { "ingressclass.kubernetes.io/is-default-class": "true" },
  },
  spec: { controller: "k8s.io/ingress-nginx" },
});

export const ingressConfig = new ConfigMap({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  data: {
    "use-forwarded-headers": "true",
    "ssl-redirect": "true",
    "proxy-body-size": "0",
  },
});

export const ingressController = new Deployment({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  spec: {
    replicas: shared.ingressReplicas,
    selector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx-controller" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "ingress-nginx-controller" } },
      spec: {
        serviceAccountName: "ingress-nginx",
        containers: [{
          name: "controller",
          image: "registry.k8s.io/ingress-nginx/controller:v1.10.0",
          args: [
            "/nginx-ingress-controller",
            "--ingress-class=nginx",
            "--configmap=system/ingress-nginx-controller",
            "--default-ssl-certificate=system/gitlab-tls",
            "--publish-service=system/ingress-nginx-controller",
          ],
          env: [
            { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
            { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
          ],
          ports: [
            { name: "http", containerPort: 80, protocol: "TCP" },
            { name: "https", containerPort: 443, protocol: "TCP" },
          ],
          resources: {
            requests: { cpu: "500m", memory: "512Mi" },
            limits: { cpu: "2", memory: "1Gi" },
          },
          livenessProbe: { httpGet: { path: "/healthz", port: 10254, scheme: "HTTP" }, initialDelaySeconds: 10, periodSeconds: 10 },
          readinessProbe: { httpGet: { path: "/healthz", port: 10254, scheme: "HTTP" }, initialDelaySeconds: 10, periodSeconds: 10 },
          securityContext: {
            runAsUser: 101,
            allowPrivilegeEscalation: true,
            capabilities: { add: ["NET_BIND_SERVICE"], drop: ["ALL"] },
          },
        }],
      },
    },
  },
});

export const ingressService = new Service({
  metadata: { name: "ingress-nginx-controller", namespace: "system", labels },
  spec: {
    type: "LoadBalancer",
    selector: { "app.kubernetes.io/name": "ingress-nginx-controller" },
    ports: [
      { name: "http", port: 80, targetPort: "http", protocol: "TCP" },
      { name: "https", port: 443, targetPort: "https", protocol: "TCP" },
    ],
  },
});

export const ingressPdb = new PodDisruptionBudget({
  metadata: { name: "ingress-nginx-controller", namespace: "system" },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx-controller" } },
  },
});

export const ingressHpa = shared.ingressHpaEnabled
  ? new HorizontalPodAutoscaler({
      metadata: { name: "ingress-nginx-controller", namespace: "system" },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "ingress-nginx-controller",
        },
        minReplicas: shared.ingressReplicas,
        maxReplicas: shared.ingressHpaMaxReplicas,
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
        ],
      },
    })
  : null;
