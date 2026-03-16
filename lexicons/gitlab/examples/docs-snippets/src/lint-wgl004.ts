import { Job, Artifacts } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL004
export const wgl004Bad = new Job({
  script: ["npm run build"],
  artifacts: new Artifacts({
    paths: ["dist/"],
  }),
});

export const wgl004Good = new Job({
  script: ["npm run build"],
  artifacts: new Artifacts({
    paths: ["dist/"],
    expire_in: "1 hour",
  }),
});
