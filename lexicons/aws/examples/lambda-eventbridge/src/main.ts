import { LambdaEventBridge, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const app = LambdaEventBridge({
  name: Sub`${AWS.StackName}-fn`,
  ruleName: Sub`${AWS.StackName}-rule`,
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
