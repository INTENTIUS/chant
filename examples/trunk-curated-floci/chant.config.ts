import type { ChantConfig } from "@intentius/chant";

// The AWS lexicon synthesizes the template, and environments are the promotion
// order. The tutorial makes this directory a workspace's only member, at its
// root, so a build here builds this project alone.
export default {
  environments: ["staging", "prod"],
  lexicons: ["aws"],
  rootOnly: true,
} satisfies ChantConfig;
