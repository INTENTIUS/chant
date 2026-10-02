import { Bucket, PublicAccessBlockConfiguration, Tag, S3BucketPolicy, Ref, Sub } from "@intentius/chant-lexicon-aws";
export const dataBucket = new Bucket({
  BucketName: "multi-stack-data",
  PublicAccessBlockConfiguration: new PublicAccessBlockConfiguration({
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  }),
  Tags: [new Tag({ Key: "Name", Value: "data-bucket" })],
});

// Deny every request that arrives over plaintext (WAW042).
export const dataBucketPolicy = new S3BucketPolicy({
  Bucket: Ref(dataBucket),
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyInsecureTransport",
        Effect: "Deny",
        Principal: "*",
        Action: "s3:*",
        Resource: [dataBucket.Arn, Sub`${dataBucket.Arn}/*`],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      },
    ],
  },
});
