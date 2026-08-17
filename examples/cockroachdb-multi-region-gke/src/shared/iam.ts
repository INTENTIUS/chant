// External Secrets Operator identity.
//
// One GCP service account reads the TLS secrets out of Secret Manager, bound
// through Workload Identity to the `external-secrets-sa` K8s account in all
// three clusters. The per-region CockroachDB and ExternalDNS identities are not
// here — GkeCrdbRegion owns those, next to the cluster they belong to.
//
// The three bindings name the same K8s subject and differ only in resource
// name, which reads like a `.map()` waiting to happen. It was one, and that is
// a function call in a value position: the build cannot fold it, and the whole
// stack drops to module execution over three lines of saved repetition.

import { GCPServiceAccount, IAMPolicyMember } from "@intentius/chant-lexicon-gcp";
import { ESO_GSA, GCP_PROJECT_ID } from "./config";

const WI_SUBJECT = `serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[kube-system/external-secrets-sa]`;

const ESO_SA_REF = {
  apiVersion: "iam.cnrm.cloud.google.com/v1beta1",
  kind: "IAMServiceAccount",
  name: ESO_GSA,
};

export const esoServiceAccount = new GCPServiceAccount({
  metadata: { name: ESO_GSA },
  displayName: "CockroachDB External Secrets Operator",
});

export const esoWiEast = new IAMPolicyMember({
  metadata: { name: `${ESO_GSA}-wi-east` },
  member: WI_SUBJECT,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: ESO_SA_REF,
});

export const esoWiCentral = new IAMPolicyMember({
  metadata: { name: `${ESO_GSA}-wi-central` },
  member: WI_SUBJECT,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: ESO_SA_REF,
});

export const esoWiWest = new IAMPolicyMember({
  metadata: { name: `${ESO_GSA}-wi-west` },
  member: WI_SUBJECT,
  role: "roles/iam.workloadIdentityUser",
  resourceRef: ESO_SA_REF,
});

export const esoSecretAccessBinding = new IAMPolicyMember({
  metadata: { name: `${ESO_GSA}-secret-access` },
  member: `serviceAccount:${ESO_GSA}@${GCP_PROJECT_ID}.iam.gserviceaccount.com`,
  role: "roles/secretmanager.secretAccessor",
  resourceRef: {
    apiVersion: "resourcemanager.cnrm.cloud.google.com/v1beta1",
    kind: "Project",
    external: `projects/${GCP_PROJECT_ID}`,
  },
});
