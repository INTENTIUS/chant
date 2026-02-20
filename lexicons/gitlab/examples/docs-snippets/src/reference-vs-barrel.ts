import * as _ from "./_";

// Preferred for chant-managed config — resolved at build time
export const testBarrel = new _.Job({
  cache: _.npmCache,
  artifacts: _.testArtifacts,
  script: ["npm test"],
});

// For external/included YAML definitions — produces !reference tags
export const testExternal = new _.Job({
  beforeScript: _.reference(".ci-setup", "before_script"),
  script: ["npm test"],
});
