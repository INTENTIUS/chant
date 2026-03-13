import { defaultAnnotations, GCP } from "@intentius/chant-lexicon-gcp";

// Inject cnrm.cloud.google.com/project-id on every GCP resource so
// Config Connector never falls back to the "default" namespace value.
export const gcpAnnotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});
