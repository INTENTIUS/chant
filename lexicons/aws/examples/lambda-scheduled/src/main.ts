import { LambdaScheduled, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const app = LambdaScheduled({
  name: Sub`${AWS.StackName}-fn`,
  ruleName: Sub`${AWS.StackName}-rule`,
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
