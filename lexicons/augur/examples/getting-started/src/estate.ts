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

/**
 * Two queues on the checkout path, and the pair is deliberate.
 *
 * `arrièreQueue` and `arrivalsQueue` share the prefix `arri` and then differ at
 * a letter outside ASCII, which makes them the one pair whose order disagrees
 * between a code-unit sort and a locale-aware one: by code unit `è` (U+00E8)
 * comes after `v`, and under an English collation it sorts as `e`, which comes
 * before.
 *
 * The request sorts entity names and edge endpoints before rendering, and the
 * first version of `request.ts` sorted them with `localeCompare` — so the same
 * estate produced two different byte streams depending on the machine's `LANG`,
 * in a module whose whole claim is that its bytes are a function of its content.
 * An all-ASCII fixture cannot catch that, because the orders that disagree are
 * exactly the ones involving letters outside it. These two are in the golden so
 * that reintroducing a collation-aware sort moves real committed bytes.
 */
export const arrivalsQueue = new Queue({
  QueueName: "checkout-arrivals",
  VisibilityTimeout: 60,
});

export const arrièreQueue = new Queue({
  QueueName: "checkout-arriere-backlog",
  VisibilityTimeout: 120,
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
