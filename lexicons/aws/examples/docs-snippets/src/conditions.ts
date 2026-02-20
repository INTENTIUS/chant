import * as _ from "./_";

export const bucket = new _.Bucket({
  bucketName: "my-bucket",
  accelerateConfiguration: _.If(
    "EnableAcceleration",
    { accelerationStatus: "Enabled" },
    _.AWS.NoValue,
  ),
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
      },
    ],
  },
});
