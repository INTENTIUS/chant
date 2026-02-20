import * as _ from "./_";

// chant-disable-next-line WGL003
export const buildBad = new _.Job({
  script: ["npm run build"],
});

export const buildGood = new _.Job({
  stage: "build",
  script: ["npm run build"],
});
