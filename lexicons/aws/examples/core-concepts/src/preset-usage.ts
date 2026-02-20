import { Bucket, BucketEncryption, ServerSideEncryptionRule } from "@intentius/chant-lexicon-aws";
import { publicAccessBlock, encryptionDefault } from "./preset-defaults";

export const secureBucket = new Bucket({
  bucketName: "secure-data",
  publicAccessBlockConfiguration: publicAccessBlock,
  bucketEncryption: new BucketEncryption({
    serverSideEncryptionConfiguration: [
      new ServerSideEncryptionRule({
        serverSideEncryptionByDefault: encryptionDefault,
      }),
    ],
  }),
});
