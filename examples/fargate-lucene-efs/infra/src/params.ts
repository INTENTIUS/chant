import { Parameter } from "@intentius/chant-lexicon-aws";

export const appName = new Parameter("String", {
  description: "App name — used in all resource names",
  defaultValue: "solr",
});
