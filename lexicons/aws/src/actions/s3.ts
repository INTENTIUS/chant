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

export type S3AccessLevel = keyof typeof S3Actions;

// A Map-backed lookup avoids computed element access (`S3Actions[access]`), which
// the evaluability lint (EVL003) flags even though the key is statically typed —
// prefer this in evaluable code such as composites (#952).
const S3_ACTIONS = new Map<S3AccessLevel, readonly string[]>(
  Object.entries(S3Actions) as [S3AccessLevel, readonly string[]][],
);
export function s3ActionsFor(access: S3AccessLevel): readonly string[] {
  return S3_ACTIONS.get(access) ?? [];
}
