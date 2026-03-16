import { Job } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL003
export const wgl003Bad = new Job({
  script: ["npm run build"],
});

export const wgl003Good = new Job({
  stage: "build",
  script: ["npm run build"],
});
