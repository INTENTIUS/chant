import { HelmCRDLifecycle } from "@intentius/chant-lexicon-helm";

const crdYaml = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: certificates.cert-manager.io
spec:
  group: cert-manager.io
  names:
    kind: Certificate
    listKind: CertificateList
    plural: certificates
    singular: certificate
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object`;

export const {
  chart: crdChart,
  values: crdValues,
  crdInstallJob,
  crdConfigMap,
  serviceAccount: crdSa,
  clusterRole,
  clusterRoleBinding,
} = HelmCRDLifecycle({
    name: "cert-manager-crd",
    crdContent: crdYaml,
    kubectlImage: "bitnami/kubectl",
    kubectlTag: "1.29",
    serviceAccountName: "crd-installer",
  });
