/**
 * Shared pipeline configuration
 */

import { Image, Cache } from "@intentius/chant-lexicon-gitlab";

// Default image for all jobs
export const defaultImage = new Image({
  name: "node:20-alpine",
});

// Standard cache configuration
export const npmCache = new Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});
