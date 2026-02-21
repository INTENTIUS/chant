import { Bucket, BucketEncryption, ServerSideEncryptionRule } from "@intentius/chant-lexicon-aws";
import { publicAccessBlock, encryptionDefault } from "./preset-defaults";

export const secureBucket = new Bucket({
  BucketName: "secure-data",
  PublicAccessBlockConfiguration: publicAccessBlock,
  BucketEncryption: new BucketEncryption({
    ServerSideEncryptionConfiguration: [
      new ServerSideEncryptionRule({
        ServerSideEncryptionByDefault: encryptionDefault,
      }),
    ],
  }),
});
