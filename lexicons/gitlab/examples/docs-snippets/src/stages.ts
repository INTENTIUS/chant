import * as _ from "./_";

export const lint = new _.Job({ stage: "test", script: ["npm run lint"] });
export const unitTest = new _.Job({ stage: "test", script: ["npm test"] });
export const build = new _.Job({ stage: "build", script: ["npm run build"] });
export const deploy = new _.Job({ stage: "deploy", script: ["npm run deploy"] });
