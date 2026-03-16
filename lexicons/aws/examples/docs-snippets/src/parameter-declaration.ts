import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Deployment environment",
  defaultValue: "dev",
});
