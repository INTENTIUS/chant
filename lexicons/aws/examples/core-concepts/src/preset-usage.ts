import * as _ from "./_";

export const secureBucket = new _.Bucket({
  bucketName: "secure-data",
  publicAccessBlockConfiguration: _.$.publicAccessBlock,
  bucketEncryption: new _.BucketEncryption({
    serverSideEncryptionConfiguration: [
      new _.ServerSideEncryptionRule({
        serverSideEncryptionByDefault: _.$.encryptionDefault,
      }),
    ],
  }),
});
