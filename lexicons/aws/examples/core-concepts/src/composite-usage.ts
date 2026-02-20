import { Sub, AWS } from "@intentius/chant-lexicon-aws";
import { LambdaService } from "./composite-definition";

export const api = LambdaService({
  name: Sub`${AWS.StackName}-api`,
  handler: "index.handler",
});
