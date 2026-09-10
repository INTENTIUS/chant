import { Parameter } from "@intentius/chant-lexicon-aws";

/**
 * The database password stays out of the declaration and out of the request.
 * `screenBehaviourRequest` would refuse a request carrying the value itself
 * (`packages/core/src/behaviour.ts`); an SSM path is a reference and passes,
 * which is the distinction the guard's reference family exists to draw.
 */
export const dbPasswordSsmPath = new Parameter("AWS::SSM::Parameter::Value<String>", {
  description: "SSM Parameter Store path holding the database password",
  defaultValue: "/checkout/dev/db-password",
});
