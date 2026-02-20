import * as _ from "./_";

// chant-disable-next-line WGL002
export const buildBad = new _.Job({
  stage: "build",
  image: new _.Image({ name: "node:20" }),
});

export const buildGood = new _.Job({
  stage: "build",
  image: new _.Image({ name: "node:20" }),
  script: ["npm run build"],
});

export const downstream = new _.Job({
  trigger: new _.Trigger({ project: "my-group/other-repo" }),
});
