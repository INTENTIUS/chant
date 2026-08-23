import type { ChantConfig } from "@intentius/chant";

// core-concepts is a collection of single-resource teaching snippets, not a
// deployable stack. Each bucket exists to illustrate one concept (a
// condition, a parameter reference, a tag), and WAW042 would want a
// BucketPolicy next to every one of them. The finding stays visible as a
// warning; the deployable examples (lambda-api, lambda-s3) carry the policy.
export default {
  lexicons: ["aws"],
  lint: { rules: { WAW042: "warning" } },
} satisfies ChantConfig;
