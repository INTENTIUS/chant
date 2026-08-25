/**
 * BucketDeployment — the seeded-bucket shape: an S3 bucket sized to receive
 * deploy-time content, encrypted and access-blocked by default, its
 * deletion behaviour and (optionally) its public-read policy declared up
 * front rather than left to CloudFormation's own defaults.
 *
 * `s3deploy.BucketDeployment` is the most-used CDK pattern across the
 * aws-bench corpus (37 instantiations across 8 apps, chant#1139) and it
 * names two things CDK bundles together that chant keeps apart on purpose:
 *
 *  - The bucket itself: `AWS::S3::Bucket` plus its encryption, access-block
 *    and (for the static-site shape) website/public-policy configuration.
 *    That is a fixed set of CloudFormation resources, so it is what this
 *    composite declares — the same shape `LambdaS3` (../composites) already
 *    gives a bucket, minus the Lambda trigger wiring.
 *  - Uploading local files into it at deploy time. CDK does this with a
 *    Lambda-backed custom resource (`cr.AwsCustomResource`, the same family
 *    the epic notes maps to chant Ops rather than composites — chant has no
 *    CloudFormation custom-resource machinery, and inventing one just to
 *    reproduce a `PutObject` loop would be new plumbing for a solved
 *    problem). chant already ships this as a deploy-time **capability**,
 *    `s3-sync` (`../components/apply.ts`'s `createS3SyncCapability`, backed
 *    by the real `aws s3 sync`/`aws s3 cp` CLI through `CloudExecutor`, with
 *    the typed step-builder `s3Sync` in `../components/builders.ts`) — it
 *    was defined for exactly this and, before this composite, had no
 *    composite pairing it with a bucket to sync into. A component composes
 *    the two:
 *
 *      const seeded = BucketDeployment({ bucketName: Sub`${AWS.StackName}-site` });
 *      // ...component `deploy` phase:
 *      s3Sync({ from: "archive:site-build", to: Sub`s3://${seeded.bucket.Ref}` })
 *
 * That split — graph-time declaration here, deploy-time action in the
 * component layer — is the existing precedent (`s3-sync` shipped in #566
 * unused by any composite until this one), not a new one invented for this
 * composite.
 *
 * "Cleanup" (the epic's third word) is `removalPolicy`, CloudFormation's own
 * `DeletionPolicy` on the bucket resource. CDK's `autoDeleteObjects` — the
 * Lambda-backed hook that empties a bucket before CloudFormation is allowed
 * to delete it — has the same custom-resource shape as content upload and
 * the same answer: out of scope here, and worth an `s3 rm --recursive`
 * step ahead of a stack teardown in the component that owns the deploy.
 */
import { Composite, mergeDefaults, type Value } from "@intentius/chant";
import {
  Bucket,
  Bucket_BucketEncryption,
  Bucket_ServerSideEncryptionRule,
  Bucket_ServerSideEncryptionByDefault,
  Bucket_PublicAccessBlockConfiguration,
  Bucket_VersioningConfiguration,
  Bucket_WebsiteConfiguration,
  S3BucketPolicy,
} from "../generated";
import { Sub } from "../intrinsics";

export interface BucketDeploymentProps {
  /** `Value<string>`: a name is routinely built with `Sub`/`Ref` (#1366). Omitted lets CloudFormation generate one. */
  bucketName?: Value<string>;
  /** Enable S3 object versioning. Default: false. */
  versioned?: boolean;
  /**
   * Static-website hosting: sets `WebsiteConfiguration` and — since a
   * website bucket is read by anonymous visitors, not IAM principals —
   * opens the public-access block and attaches a public-read
   * `S3BucketPolicy` scoped to `s3:GetObject`. Omitted, the bucket stays
   * fully private, matching every other composite bucket's default
   * (`LambdaS3`, ../composites).
   */
  website?: {
    indexDocument: string;
    errorDocument?: string;
  };
  /** What CloudFormation does to the bucket when the stack (or the resource) is removed. Default: "retain" — CloudFormation's own default, and the safe one for a bucket a deploy has just put content into. */
  removalPolicy?: "retain" | "destroy";
  tags?: Array<{ Key: string; Value: string }>;
  defaults?: {
    bucket?: Partial<ConstructorParameters<typeof Bucket>[0]>;
    bucketPolicy?: Partial<ConstructorParameters<typeof S3BucketPolicy>[0]>;
  };
}

export type BucketDeploymentResult =
  | { bucket: InstanceType<typeof Bucket> }
  | { bucket: InstanceType<typeof Bucket>; bucketPolicy: InstanceType<typeof S3BucketPolicy> };

export const BucketDeployment = Composite<BucketDeploymentProps>((props) => {
  const { defaults } = props;
  const publicRead = props.website !== undefined;

  const encryptionDefault = new Bucket_ServerSideEncryptionByDefault({ SSEAlgorithm: "AES256" });
  const encryptionRule = new Bucket_ServerSideEncryptionRule({ ServerSideEncryptionByDefault: encryptionDefault });
  const bucketEncryption = new Bucket_BucketEncryption({ ServerSideEncryptionConfiguration: [encryptionRule] });

  // A ternary, not an `if`, so the block-scoped `new` stays an expression
  // (EVL002) — the same reasoning eks-cluster.ts's addon slots document.
  const publicAccessBlock = new Bucket_PublicAccessBlockConfiguration(
    publicRead
      ? { BlockPublicAcls: false, BlockPublicPolicy: false, IgnorePublicAcls: false, RestrictPublicBuckets: false }
      : { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  );

  const versioningConfiguration = props.versioned
    ? new Bucket_VersioningConfiguration({ Status: "Enabled" })
    : undefined;

  const websiteConfiguration = props.website
    ? new Bucket_WebsiteConfiguration({
        IndexDocument: props.website.indexDocument,
        ...(props.website.errorDocument ? { ErrorDocument: props.website.errorDocument } : {}),
      })
    : undefined;

  const bucket = new Bucket(
    mergeDefaults(
      {
        BucketName: props.bucketName,
        BucketEncryption: bucketEncryption,
        PublicAccessBlockConfiguration: publicAccessBlock,
        ...(versioningConfiguration ? { VersioningConfiguration: versioningConfiguration } : {}),
        ...(websiteConfiguration ? { WebsiteConfiguration: websiteConfiguration } : {}),
        Tags: props.tags,
      },
      defaults?.bucket,
    ),
    { DeletionPolicy: props.removalPolicy === "destroy" ? "Delete" : "Retain" },
  );

  const bucketPolicy = publicRead
    ? new S3BucketPolicy(
        mergeDefaults(
          {
            Bucket: bucket.Ref,
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: Sub`${bucket.Arn}/*` },
              ],
            },
          },
          defaults?.bucketPolicy,
        ),
      )
    : undefined;

  // Spread rather than a ternary between two object shapes (EksCluster's
  // addon slots, ../eks-cluster.ts, hit the same union-return typing wall):
  // a key that is sometimes present, never a key whose value is sometimes
  // `undefined` — `CompositeMembers`' index signature requires `Declarable`,
  // not `Declarable | undefined`.
  return { bucket, ...(bucketPolicy ? { bucketPolicy } : {}) };
}, "BucketDeployment");
