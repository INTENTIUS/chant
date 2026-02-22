import { LambdaSns, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

export const app = LambdaSns({
  name: Sub`${AWS.StackName}-${Ref(environment)}-fn`,
  topicName: Sub`${AWS.StackName}-${Ref(environment)}-topic`,
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
