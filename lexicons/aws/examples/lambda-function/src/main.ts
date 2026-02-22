import { LambdaNode, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const app = LambdaNode({
  name: Sub`${AWS.StackName}-fn`,
  Code: {
    ZipFile: `exports.handler = async (event) => {
  console.log("Event:", JSON.stringify(event));
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Hello from Lambda!" }),
  };
};`,
  },
});
