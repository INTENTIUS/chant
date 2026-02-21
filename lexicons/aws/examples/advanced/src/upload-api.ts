import { Role_Policy, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";
import { SecureApi } from "./lambda-api";

export const uploadPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:PutObject"],
      Resource: [Sub`${dataBucket.Arn}/*`],
    },
  ],
};

export const uploadS3Policy = new Role_Policy({
  PolicyName: "S3PutAccess",
  PolicyDocument: uploadPolicyDocument,
});

export const uploadApi = SecureApi({
  name: Sub`${AWS.StackName}-upload`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    ZipFile: `exports.handler = async (event) => {
      // Handle file upload
      return { statusCode: 200 };
    };`,
  },
  environment: {
    Variables: {
      BUCKET_NAME: dataBucket.Arn,
    },
  },
  policies: [uploadS3Policy],
});
