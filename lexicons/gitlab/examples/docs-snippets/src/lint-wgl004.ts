import { Job, Artifacts } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL004
export const buildBad = new Job({
  script: ["npm run build"],
  artifacts: new Artifacts({
    paths: ["dist/"],
  }),
});

export const buildGood = new Job({
  script: ["npm run build"],
  artifacts: new Artifacts({
    paths: ["dist/"],
    expireIn: "1 hour",
  }),
});
