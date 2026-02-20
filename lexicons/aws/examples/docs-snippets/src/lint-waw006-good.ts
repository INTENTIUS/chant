import * as _ from "./_";

export const bucket = new _.Bucket({
  bucketName: "my-bucket",
  bucketEncryption: {
    serverSideEncryptionConfiguration: [
      {
        serverSideEncryptionByDefault: { sseAlgorithm: "AES256" },
      },
    ],
  },
});
