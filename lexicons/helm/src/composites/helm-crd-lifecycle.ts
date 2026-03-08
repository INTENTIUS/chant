/**
 * HelmCRDLifecycle composite — managed CRD lifecycle via Helm hooks.
 *
 * Produces a Job-based CRD installer that runs as a pre-install/pre-upgrade
 * hook, solving the Helm limitation that CRDs in crds/ are never upgraded
 * or deleted.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values, Job, ConfigMap, ServiceAccount, ClusterRole, ClusterRoleBinding } from "../resources";
import { values, include, printf } from "../intrinsics";

export interface HelmCRDLifecycleProps {
  /** Chart and release name. */
  name: string;
  /** Raw CRD YAML content. */
  crdContent: string;
  /** kubectl image. Default: "bitnami/kubectl" */
  kubectlImage?: string;
  /** kubectl image tag. Default: "latest" */
  kubectlTag?: string;
  /** ServiceAccount name for RBAC. */
  serviceAccountName?: string;
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    values?: Partial<Record<string, unknown>>;
    crdInstallJob?: Partial<Record<string, unknown>>;
    crdConfigMap?: Partial<Record<string, unknown>>;
    serviceAccount?: Partial<Record<string, unknown>>;
    clusterRole?: Partial<Record<string, unknown>>;
    clusterRoleBinding?: Partial<Record<string, unknown>>;
  };
}

export interface HelmCRDLifecycleResult {
  chart: InstanceType<typeof Chart>;
  values: InstanceType<typeof Values>;
  crdInstallJob: InstanceType<typeof Job>;
  crdConfigMap: InstanceType<typeof ConfigMap>;
  serviceAccount: InstanceType<typeof ServiceAccount>;
  clusterRole: InstanceType<typeof ClusterRole>;
  clusterRoleBinding: InstanceType<typeof ClusterRoleBinding>;
}

export const HelmCRDLifecycle = Composite<HelmCRDLifecycleProps>((props) => {
  const {
    name,
    crdContent,
    kubectlImage = "bitnami/kubectl",
    kubectlTag = "latest",
    serviceAccountName,
    defaults: defs,
  } = props;

  const saName = serviceAccountName ?? `${name}-crd-installer`;

  const chart = new Chart(mergeDefaults({
    apiVersion: "v2",
    name,
    version: "0.1.0",
    type: "application",
    description: `CRD lifecycle management for ${name}`,
  }, defs?.chart));

  const valuesRes = new Values(mergeDefaults({
    crdLifecycle: {
      enabled: true,
      kubectl: {
        image: kubectlImage,
        tag: kubectlTag,
      },
      serviceAccount: {
        name: saName,
      },
    },
  } as Record<string, unknown>, defs?.values));

  const hookAnnotations = {
    "helm.sh/hook": "pre-install,pre-upgrade",
    "helm.sh/hook-weight": "-5",
    "helm.sh/hook-delete-policy": "before-hook-creation",
  };

  const crdConfigMap = new ConfigMap(mergeDefaults({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: printf("%s-crd-content", include(`${name}.fullname`)),
      labels: include(`${name}.labels`),
      annotations: hookAnnotations,
    },
    data: {
      "crds.yaml": crdContent,
    },
  }, defs?.crdConfigMap));

  const serviceAccount = new ServiceAccount(mergeDefaults({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: values.crdLifecycle.serviceAccount.name,
      labels: include(`${name}.labels`),
      annotations: hookAnnotations,
    },
  }, defs?.serviceAccount));

  const clusterRole = new ClusterRole(mergeDefaults({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: {
      name: printf("%s-crd-installer", include(`${name}.fullname`)),
      labels: include(`${name}.labels`),
      annotations: hookAnnotations,
    },
    rules: [{
      apiGroups: ["apiextensions.k8s.io"],
      resources: ["customresourcedefinitions"],
      verbs: ["get", "list", "create", "update", "patch"],
    }],
  }, defs?.clusterRole));

  const clusterRoleBinding = new ClusterRoleBinding(mergeDefaults({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: {
      name: printf("%s-crd-installer", include(`${name}.fullname`)),
      labels: include(`${name}.labels`),
      annotations: hookAnnotations,
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: printf("%s-crd-installer", include(`${name}.fullname`)),
    },
    subjects: [{
      kind: "ServiceAccount",
      name: values.crdLifecycle.serviceAccount.name,
      namespace: "{{ .Release.Namespace }}",
    }],
  }, defs?.clusterRoleBinding));

  const crdInstallJob = new Job(mergeDefaults({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: printf("%s-crd-install", include(`${name}.fullname`)),
      labels: include(`${name}.labels`),
      annotations: hookAnnotations,
    },
    spec: {
      template: {
        metadata: {
          labels: include(`${name}.selectorLabels`),
        },
        spec: {
          serviceAccountName: values.crdLifecycle.serviceAccount.name,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
          },
          containers: [{
            name: "crd-installer",
            image: printf("%s:%s", values.crdLifecycle.kubectl.image, values.crdLifecycle.kubectl.tag),
            command: ["kubectl", "apply", "-f", "/crds/"],
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
            },
            volumeMounts: [{
              name: "crd-content",
              mountPath: "/crds",
              readOnly: true,
            }],
          }],
          volumes: [{
            name: "crd-content",
            configMap: {
              name: printf("%s-crd-content", include(`${name}.fullname`)),
            },
          }],
        },
      },
    },
  }, defs?.crdInstallJob));

  return {
    chart,
    values: valuesRes,
    crdInstallJob,
    crdConfigMap,
    serviceAccount,
    clusterRole,
    clusterRoleBinding,
  };
}, "HelmCRDLifecycle");
