import { Sub, AWS, Role_Policy, NodeLambda, SNSActions } from "@intentius/chant-lexicon-aws";
import { alertTopic } from "./alert-topic";

export const notifierPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: SNSActions.Publish,
      Resource: alertTopic.Arn,
    },
  ],
};

export const notifierPolicy = new Role_Policy({
  PolicyName: "SNSPublish",
  PolicyDocument: notifierPolicyDocument,
});

// NodeLambda with SNS publish permissions
export const notifier = NodeLambda({
  name: Sub`${AWS.StackName}-notifier`,
  Code: {
    ZipFile: `const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
exports.handler = async (event) => {
  const sns = new SNSClient({});
  await sns.send(new PublishCommand({
    TopicArn: process.env.TOPIC_ARN,
    Message: JSON.stringify(event),
  }));
  return { statusCode: 200 };
};`,
  },
  Environment: { Variables: { TOPIC_ARN: alertTopic.Arn } },
  Policies: [notifierPolicy],
});
