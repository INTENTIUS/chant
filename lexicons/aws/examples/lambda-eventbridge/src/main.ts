import { LambdaEventBridge, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

export const app = LambdaEventBridge({
  name: Sub`${AWS.StackName}-${Ref(environment)}-fn`,
  ruleName: Sub`${AWS.StackName}-${Ref(environment)}-rule`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `exports.handler = async (event) => {
  console.log("EventBridge event:", JSON.stringify(event));
  const { source, "detail-type": detailType, detail } = event;
  console.log(\`Source: \${source}, Type: \${detailType}\`);
  return { statusCode: 200 };
};`,
  },
  eventPattern: {
    source: ["aws.s3"],
    "detail-type": ["Object Created"],
  },
});
