export const S3Actions = {
  // Broad groups (from AWS managed policies)
  ReadOnly: [
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:GetBucketLocation",
    "s3:ListBucket",
    "s3:ListBucketVersions",
  ],
  WriteOnly: [
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:PutObjectAcl",
    "s3:AbortMultipartUpload",
  ],
  ReadWrite: [
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:GetBucketLocation",
    "s3:ListBucket",
    "s3:ListBucketVersions",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:PutObjectAcl",
    "s3:AbortMultipartUpload",
  ],
  Full: ["s3:*"],

  // Operation-specific
  GetObject: ["s3:GetObject", "s3:GetObjectVersion"],
  PutObject: ["s3:PutObject", "s3:AbortMultipartUpload"],
  DeleteObject: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
  ListObjects: ["s3:ListBucket", "s3:ListBucketVersions"],
} as const;
