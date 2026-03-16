import { LambdaScheduled, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

export const app = LambdaScheduled({
  name: Sub`${AWS.StackName}-${Ref(environment)}-fn`,
  ruleName: Sub`${AWS.StackName}-${Ref(environment)}-rule`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `exports.handler = async () => {
  console.log("Running scheduled cleanup at", new Date().toISOString());
  // Add cleanup logic here
  return { statusCode: 200 };
};`,
  },
  schedule: "rate(1 hour)",
});
