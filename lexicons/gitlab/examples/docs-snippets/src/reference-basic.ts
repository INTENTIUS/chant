import { Job, reference } from "@intentius/chant-lexicon-gitlab";

export const deployRef = new Job({
  script: reference(".setup", "script"),
});
