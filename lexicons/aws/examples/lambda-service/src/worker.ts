import { Sub, AWS, Role_Policy, NodeLambda, S3Actions } from "@intentius/chant-lexicon-aws";
import { outputBucket } from "./output-bucket";

export const workerPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: S3Actions.PutObject,
      Resource: Sub`${outputBucket.Arn}/*`,
    },
  ],
};

export const workerPolicy = new Role_Policy({
  PolicyName: "S3Write",
  PolicyDocument: workerPolicyDocument,
});

// NodeLambda: Role + Function with nodejs20.x + index.handler defaults
export const worker = NodeLambda({
  name: Sub`${AWS.StackName}-worker`,
  Code: {
    ZipFile: `exports.handler = async (event) => {
      console.log("Processing:", JSON.stringify(event));
      return { statusCode: 200 };
    };`,
  },
  MemorySize: 512,
  Environment: { Variables: { OUTPUT_BUCKET: outputBucket.Arn } },
  Policies: [workerPolicy],
});
