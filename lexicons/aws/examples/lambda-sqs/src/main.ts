import { LambdaSqs, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const app = LambdaSqs({
  name: Sub`${AWS.StackName}-fn`,
  queueName: Sub`${AWS.StackName}-queue`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `exports.handler = async (event) => {
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    console.log("Processing message:", body);
  }
  return { batchItemFailures: [] };
};`,
  },
  batchSize: 10,
});
