import { Job, reference } from "@intentius/chant-lexicon-gitlab";
import { npmCache, testArtifacts } from "./config";

// Preferred for chant-managed config — resolved at build time
export const testBarrel = new Job({
  cache: npmCache,
  artifacts: testArtifacts,
  script: ["npm test"],
});

// For external/included YAML definitions — produces !reference tags
export const testExternal = new Job({
  beforeScript: reference(".ci-setup", "before_script"),
  script: ["npm test"],
});
