import { Job, Image, Trigger } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL002
export const buildBad = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
});

export const buildGood = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
  script: ["npm run build"],
});

export const downstream = new Job({
  trigger: new Trigger({ project: "my-group/other-repo" }),
});
