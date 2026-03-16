import { Bucket, BucketEncryption, ServerSideEncryptionRule, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { publicAccessBlock, encryptionDefault } from "./preset-defaults";
import { environment } from "./parameters";

export const secureBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${Ref(environment)}-secure-data`,
  PublicAccessBlockConfiguration: publicAccessBlock,
  BucketEncryption: new BucketEncryption({
    ServerSideEncryptionConfiguration: [
      new ServerSideEncryptionRule({
        ServerSideEncryptionByDefault: encryptionDefault,
      }),
    ],
  }),
});
