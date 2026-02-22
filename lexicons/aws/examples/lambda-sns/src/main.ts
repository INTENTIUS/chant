import { LambdaSns, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const app = LambdaSns({
  name: Sub`${AWS.StackName}-fn`,
  topicName: Sub`${AWS.StackName}-topic`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    console.log("Received notification:", message);
  }
  return { statusCode: 200 };
};`,
  },
});
