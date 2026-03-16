import { LambdaSqs, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

export const app = LambdaSqs({
  name: Sub`${AWS.StackName}-${Ref(environment)}-fn`,
  queueName: Sub`${AWS.StackName}-${Ref(environment)}-queue`,
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
