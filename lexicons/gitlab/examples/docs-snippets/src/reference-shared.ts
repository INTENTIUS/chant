import { Job, reference } from "@intentius/chant-lexicon-gitlab";

// Shared setup scripts from external YAML
export const testRef = new Job({
  stage: "test",
  before_script: reference(".node-setup", "before_script"),
  script: ["npm test"],
});

export const lintRef = new Job({
  stage: "test",
  before_script: reference(".node-setup", "before_script"),
  script: ["npm run lint"],
});

// Shared rules
export const buildRef = new Job({
  stage: "build",
  rules: reference(".default-rules", "rules"),
  script: ["npm run build"],
});
