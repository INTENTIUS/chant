import { Role_Policy, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";
import { HighMemoryApi } from "./lambda-api";

export const processPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: [Sub`${dataBucket.arn}/*`],
    },
  ],
};

export const processS3Policy = new Role_Policy({
  policyName: "S3ReadWriteAccess",
  policyDocument: processPolicyDocument,
});

export const processApi = HighMemoryApi({
  name: Sub`${AWS.StackName}-process`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    zipFile: `exports.handler = async (event) => {
      // Process large datasets
      return { statusCode: 200 };
    };`,
  },
  environment: {
    variables: {
      BUCKET_NAME: dataBucket.arn,
    },
  },
  policies: [processS3Policy],
});
