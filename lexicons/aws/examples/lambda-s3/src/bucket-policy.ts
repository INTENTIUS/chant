import { S3BucketPolicy, Ref, Sub } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

// Deny every request that arrives over plaintext (WAW042).
export const denyInsecureTransport = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [app.bucket.Arn, Sub`${app.bucket.Arn}/*`],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ],
};

// The composite owns the bucket; the policy is attached here as its own resource.
// chant-disable-next-line COR004
export const appBucketPolicy = new S3BucketPolicy({
  Bucket: Ref(app.bucket),
  PolicyDocument: denyInsecureTransport,
});
