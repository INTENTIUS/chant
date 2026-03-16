import { Job, Image, Trigger, Include, Rule } from "@intentius/chant-lexicon-gitlab";

const nodeImage = new Image({ name: "node:22-alpine" });

const workspaces = ["packages/api", "packages/web", "packages/shared"];

// Trigger child pipelines per workspace using rules-based inclusion
export const triggerApi = new Job({
  _name: "trigger-api",
  stage: "triggers",
  trigger: new Trigger({
    include: [
      new Include({ local: "packages/api/.gitlab-ci.yml" }),
    ],
    strategy: "depend",
  }),
  rules: [
    new Rule({ changes: ["packages/api/**/*", "packages/shared/**/*"] }),
  ],
});

export const triggerWeb = new Job({
  _name: "trigger-web",
  stage: "triggers",
  trigger: new Trigger({
    include: [
      new Include({ local: "packages/web/.gitlab-ci.yml" }),
    ],
    strategy: "depend",
  }),
  rules: [
    new Rule({ changes: ["packages/web/**/*", "packages/shared/**/*"] }),
  ],
});

export const triggerShared = new Job({
  _name: "trigger-shared",
  stage: "triggers",
  trigger: new Trigger({
    include: [
      new Include({ local: "packages/shared/.gitlab-ci.yml" }),
    ],
    strategy: "depend",
  }),
  rules: [
    new Rule({ changes: ["packages/shared/**/*"] }),
  ],
});

export const lint = new Job({
  stage: "validate",
  image: nodeImage,
  script: ["npm install", "npm run lint"],
  rules: [
    new Rule({ changes: workspaces.map((w) => `${w}/**/*`) }),
  ],
});
