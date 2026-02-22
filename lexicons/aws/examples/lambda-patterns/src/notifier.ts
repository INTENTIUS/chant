import {
  Sub,
  AWS,
  Role_Policy,
  NodeLambda,
  SNSActions,
  Topic,
} from "@intentius/chant-lexicon-aws";

export const alertTopic = new Topic({
  TopicName: Sub`${AWS.StackName}-alerts`,
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
  Policies: [
    new Role_Policy({
      PolicyName: "SNSPublish",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: SNSActions.Publish,
            Resource: alertTopic.Arn,
          },
        ],
      },
    }),
  ],
});
