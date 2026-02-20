import * as _ from "./_";

// Shared setup scripts from external YAML
export const testRef = new _.Job({
  stage: "test",
  beforeScript: _.reference(".node-setup", "before_script"),
  script: ["npm test"],
});

export const lintRef = new _.Job({
  stage: "test",
  beforeScript: _.reference(".node-setup", "before_script"),
  script: ["npm run lint"],
});

// Shared rules
export const buildRef = new _.Job({
  stage: "build",
  rules: _.reference(".default-rules", "rules"),
  script: ["npm run build"],
});
