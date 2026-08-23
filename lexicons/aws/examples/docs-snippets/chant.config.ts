import type { ChantConfig } from "@intentius/chant";

// docs-snippets is the code embedded in the lexicon docs, not a deployable
// stack. Each bucket illustrates one page's concept, and WAW042 would want
// a BucketPolicy next to every one of them; the one DBCluster is a
// serialization example, not a backup plan. Both stay visible as warnings;
// the deployable examples (lambda-api, lambda-s3, rds-postgres) satisfy
// the checks for real.
export default {
  lexicons: ["aws"],
  lint: { rules: { WAW039: "warning", WAW042: "warning" } },
} satisfies ChantConfig;
