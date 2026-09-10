import { S3BucketPolicy, Ref, Sub } from "@intentius/chant-lexicon-aws";
import { receipts } from "./estate";

/**
 * Deny every request that arrives over plaintext (WAW042).
 *
 * Worth having in an augur example for a second reason: `AWS::S3::BucketPolicy`
 * is one of the types the coverage table declares unmapped. A policy is a grant
 * on the bucket beside it, and the bucket carries the figures — so this entity
 * appears in the build, appears in the report as `unsupported-kind` with that
 * sentence attached, and never as an object priced at nothing.
 */
export const denyInsecureTransport = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [receipts.Arn, Sub`${receipts.Arn}/*`],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ],
};

export const receiptsPolicy = new S3BucketPolicy({
  Bucket: Ref(receipts),
  PolicyDocument: denyInsecureTransport,
});
