import { Job } from "@intentius/chant-lexicon-gitlab";

export const lint = new Job({ stage: "test", script: ["npm run lint"] });
export const unitTest = new Job({ stage: "test", script: ["npm test"] });
export const build = new Job({ stage: "build", script: ["npm run build"] });
export const deploy = new Job({ stage: "deploy", script: ["npm run deploy"] });
