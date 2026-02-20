import { Job } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL003
export const buildBad = new Job({
  script: ["npm run build"],
});

export const buildGood = new Job({
  stage: "build",
  script: ["npm run build"],
});
