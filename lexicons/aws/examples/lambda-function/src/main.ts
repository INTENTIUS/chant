import { LambdaNode, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

export const app = LambdaNode({
  name: Sub`${AWS.StackName}-${Ref(environment)}-fn`,
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
