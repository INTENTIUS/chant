import * as _ from "./_";

export const uploadPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:PutObject"],
      Resource: [_.Sub`${_.$.dataBucket.arn}/*`],
    },
  ],
};

export const uploadS3Policy = new _.Role_Policy({
  policyName: "S3PutAccess",
  policyDocument: uploadPolicyDocument,
});

export const uploadApi = _.$.SecureApi({
  name: _.Sub`${_.AWS.StackName}-upload`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    zipFile: `exports.handler = async (event) => {
      // Handle file upload
      return { statusCode: 200 };
    };`,
  },
  environment: {
    variables: {
      BUCKET_NAME: _.$.dataBucket.arn,
    },
  },
  policies: [uploadS3Policy],
});
