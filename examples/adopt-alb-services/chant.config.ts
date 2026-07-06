import type { ChantConfig } from "@intentius/chant";

// The aws lexicon both synthesizes the CloudFormation templates (chant build)
// and contributes the component capabilities that deploy them (cfn-deploy,
// publish-image, wait-steady-state) — one `lexicons: ["aws"]`, both halves.
export default { lexicons: ["aws"] } satisfies ChantConfig;
