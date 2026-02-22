import { Role_Policy, Sub, AWS, Ref, S3Actions } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";
import { HighMemoryApi } from "./lambda-api";
import { environment } from "./params";

export const processPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: S3Actions.ReadWrite,
      Resource: [Sub`${dataBucket.Arn}/*`],
    },
  ],
};

export const processS3Policy = new Role_Policy({
  PolicyName: "S3ReadWriteAccess",
  PolicyDocument: processPolicyDocument,
});

export const processApi = HighMemoryApi({
  name: Sub`${AWS.StackName}-${Ref(environment)}-process`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    ZipFile: `exports.handler = async (event) => {
      // Process large datasets
      return { statusCode: 200 };
    };`,
  },
  environment: {
    Variables: {
      BUCKET_NAME: dataBucket.Arn,
    },
  },
  policies: [processS3Policy],
});
