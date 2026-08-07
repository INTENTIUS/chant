import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

// One project for the whole estate. The serializer merges this annotation into
// every manifest; the applier and both read paths resolve the project from it
// (#1582), so nothing here needs GOOGLE_CLOUD_PROJECT exported.
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": "local-project",
});
