import { Bucket, PublicAccessBlockConfiguration, Tag, S3BucketPolicy, Ref, Sub } from "@intentius/chant-lexicon-aws";
export const myBucket = new Bucket({
  BucketName: "my-test-bucket",
  PublicAccessBlockConfiguration: new PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
  Tags: [new Tag({ Key: "Environment", Value: "test" })],
});

// Deny every request that arrives over plaintext (WAW042).
export const myBucketPolicy = new S3BucketPolicy({
  Bucket: Ref(myBucket),
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [myBucket.Arn, Sub`${myBucket.Arn}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  },
});
