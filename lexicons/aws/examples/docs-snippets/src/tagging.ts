import * as _ from "./_";

export const bucket = new _.Bucket({
  bucketName: "my-bucket",
  tags: [
    { key: "Environment", value: "production" },
    { key: "Team", value: "platform" },
  ],
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
      },
    ],
  },
});
