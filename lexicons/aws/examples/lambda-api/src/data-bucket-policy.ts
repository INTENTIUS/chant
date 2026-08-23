import { S3BucketPolicy, Ref, Sub } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";

// Deny every request that arrives over plaintext (WAW042).
export const denyInsecureTransport = {
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
};

// CloudFormation models a bucket policy as its own resource, so it is one here too.
export const dataBucketPolicy = new S3BucketPolicy({
  Bucket: Ref(dataBucket),
  PolicyDocument: denyInsecureTransport,
});
