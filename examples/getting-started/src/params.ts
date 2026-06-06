// A deploy-time input.
//
// Its value is not known at synthesis. chant emits a CloudFormation Parameter
// placeholder and the platform fills it in at apply. This is one of the three
// places a value can come from — see the "Where Values Come From" concept doc.
import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Runtime environment (dev, staging, prod)",
  defaultValue: "dev",
});
