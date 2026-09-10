/**
 * The estate to be predicted: an ordinary aws declaration, untouched by augur.
 *
 * augur adds nothing to it and changes nothing in it. That is the whole
 * arrangement — a project declares its estate in whichever lexicons it already
 * uses, and augur reads what is there. Swapping this file for a k8s one, or a
 * gcp one, changes what the coverage table says about each entity and changes
 * nothing else.
 *
 * The composites are aws's own (`VpcDefault`, `RdsInstance`), which is why this
 * builds without a hand-written subnet or security group. What reaches a
 * behaviour engine, and what does not, is the point of the example: the
 * database is a `database` on the wire, the VPC and the subnets are declared
 * unmapped, and the security group is declared unmapped. Run `chant build` and
 * read `build/augur` for the questions; `src/../../../src/request.ts` builds
 * the request itself.
 */

import { Queue, Bucket, RdsInstance, VpcDefault, Ref } from "@intentius/chant-lexicon-aws";
import { dbPasswordSsmPath } from "./params";

export const network = VpcDefault({});

export const database = RdsInstance({
  engine: "postgres",
  vpcId: network.vpc.VpcId,
  subnetIds: [network.privateSubnet1.SubnetId, network.privateSubnet2.SubnetId],
  ingressCidr: "10.0.0.0/16",
  masterPassword: Ref(dbPasswordSsmPath) as unknown as string,
  databaseName: "checkout",
});

/** A queue on the checkout path. Mapped: `AWS::SQS::Queue` is a `queue`. */
export const orders = new Queue({
  QueueName: "checkout-orders",
  VisibilityTimeout: 60,
});

/**
 * Object storage for the receipts. Mapped as `object-store`, and priced by an
 * engine on a model the declaration says nothing about — which is the engine's
 * problem to state a tolerance for, not chant's to guess at.
 */
export const receipts = new Bucket({
  BucketName: "checkout-receipts",
  BucketEncryption: {
    ServerSideEncryptionConfiguration: [
      { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
    ],
  },
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  },
});
