import * as _ from "./_";

// chant-disable-next-line WGL004
export const buildBad = new _.Job({
  script: ["npm run build"],
  artifacts: new _.Artifacts({
    paths: ["dist/"],
  }),
});

export const buildGood = new _.Job({
  script: ["npm run build"],
  artifacts: new _.Artifacts({
    paths: ["dist/"],
    expireIn: "1 hour",
  }),
});
