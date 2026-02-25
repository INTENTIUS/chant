import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Runtime environment",
  defaultValue: "dev",
});

export const dbPasswordSsmPath = new Parameter("AWS::SSM::Parameter::Value<String>", {
  description: "SSM Parameter Store path containing the database password",
  defaultValue: "/myapp/dev/db-password",
});
