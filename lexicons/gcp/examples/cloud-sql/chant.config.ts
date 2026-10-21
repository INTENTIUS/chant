import type { ChantConfig } from "@intentius/chant";

// The example reads GCP.ProjectId and GCP.Region, which a build resolves from
// these variables (#4200). Set them to your own project and region to deploy.
process.env.GCP_PROJECT_ID ??= "example-project";
process.env.GCP_REGION ??= "us-central1";

export default { lexicons: ["gcp"] } satisfies ChantConfig;
