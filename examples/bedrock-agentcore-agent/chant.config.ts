import type { ChantConfig } from "@intentius/chant";

// The aws lexicon both synthesizes the CloudFormation template (chant build)
// and contributes the component capabilities that deploy it (cfn-deploy,
// wait-for-stack) — one `lexicons: ["aws"]`, both halves.
export default { lexicons: ["aws"] } satisfies ChantConfig;
