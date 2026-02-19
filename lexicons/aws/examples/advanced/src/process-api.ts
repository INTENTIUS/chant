import * as _ from "./_";

export const processPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject"],
      Resource: [_.Sub`${_.$.dataBucket.arn}/*`],
    },
  ],
};

export const processS3Policy = new _.Role_Policy({
  policyName: "S3ReadWriteAccess",
  policyDocument: processPolicyDocument,
});

export const processApi = _.$.HighMemoryApi({
  name: _.Sub`${_.AWS.StackName}-process`,
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
      BUCKET_NAME: _.$.dataBucket.arn,
    },
  },
  policies: [processS3Policy],
});
