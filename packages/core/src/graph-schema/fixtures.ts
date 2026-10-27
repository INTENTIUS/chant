/**
 * The fixture documents engines test their output against (#4527): one
 * engine graph per engine and one index version. The compiler checks each
 * against chant's types here; ./generate.ts writes them to ./fixtures/*.json,
 * and ./graph-schema.test.ts validates those files against the generated
 * schema. Shapes follow #4520's design section 3 and behold#1025's ruling.
 *
 * No record payloads, no output values and no secrets, the rule both
 * emitters keep (choudoufu#2285, plunge#40).
 */
import type { EngineGraphDocument } from "../engine-facts";
import { indexDocumentDigest, indexScopeKey, type CloudIndexScope, type IndexDocument } from "../lifecycle/index-document";

/** What `choudoufu live-graph -json -from-plan=<file> -history` prints for a small estate. */
const choudoufu: EngineGraphDocument = {
  version: 1,
  meta: {
    engineGraph: {
      format: 1,
      engine: { name: "choudoufu", version: "0.33.0" },
      scope: { kind: "estate", estate: "web" },
      observedAt: "2026-10-26T12:00:00Z",
      markerScheme: {
        ownerKey: "tofu-estate",
        addressKey: "tofu-address",
        continuationKeys: ["tofu-slot"],
        encoding: { tags: "escaped", labels: "escaped" },
      },
      gaps: [{ address: "aws_iam_role.legacy", reason: "unsupported-kind", detail: "no lister for this type on this provider" }],
    },
  },
  nodes: [
    {
      id: "aws_s3_bucket.logs",
      kind: "aws_s3_bucket",
      lexicon: "terraform",
      attrs: { address: "aws_s3_bucket.logs" },
      physicalId: "web-logs",
      facts: {
        ownership: "bound",
        ownedBy: "record",
        cloudIds: [
          { kind: "import-id", value: "web-logs" },
          { kind: "arn", value: "arn:aws:s3:::web-logs" },
        ],
        recordVersions: {
          kept: true,
          versions: [
            { id: "3sL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY", writtenAt: "2026-10-26T11:58:02Z", current: true, deleted: false },
            { id: "2bE8x0l1BqzDmoPTmD7M7bGqFrsTFTQS", writtenAt: "2026-10-20T09:14:40Z", current: false, deleted: false },
          ],
        },
        observedAt: "2026-10-26T12:00:00Z",
      },
    },
    {
      id: "module.app.aws_eip.pool",
      kind: "aws_eip",
      lexicon: "terraform",
      attrs: { address: "module.app.aws_eip.pool" },
    },
    {
      id: "module.app.aws_instance.web",
      kind: "aws_instance",
      lexicon: "terraform",
      attrs: { address: "module.app.aws_instance.web" },
    },
    {
      id: "module.app[0].aws_eip.pool[1]",
      kind: "aws_eip",
      lexicon: "terraform",
      attrs: { address: "module.app[0].aws_eip.pool[1]" },
      physicalId: "eipalloc-0abc",
      instanceOf: "module.app.aws_eip.pool",
      instanceKey: "[1]",
      instanceScope: "module.app[0]",
      facts: {
        ownership: "bound",
        ownedBy: "marker",
        markers: { owner: "web", address: "module.app[0].aws_eip.pool[1]", encoding: "escaped", source: "live" },
        cloudIds: [{ kind: "import-id", value: "eipalloc-0abc" }],
        observedAt: "2026-10-26T12:00:00Z",
      },
    },
    {
      id: "aws_sqs_queue.jobs",
      kind: "aws_sqs_queue",
      lexicon: "terraform",
      attrs: { address: "aws_sqs_queue.jobs" },
      facts: {
        ownership: "foreign",
        markers: { owner: "billing", encoding: "escaped", source: "live" },
        observedAt: "2026-10-26T12:00:00Z",
      },
    },
    {
      id: "aws_sns_topic.alerts",
      kind: "aws_sns_topic",
      lexicon: "terraform",
      attrs: { address: "aws_sns_topic.alerts" },
      facts: { ownership: "pending", observedAt: "2026-10-26T12:00:00Z" },
    },
  ],
  edges: [
    { from: "module.app[0].aws_eip.pool[1]", to: "module.app.aws_instance.web", kind: "ref", viaAttr: "dependencies", grain: "block" },
    { from: "module.app.aws_instance.web", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "dependencies", grain: "block" },
  ],
  groups: {},
};

const URN = "urn:pulumi:dev::app::";

/** What `plunge graph --json --stack dev --versions` prints for a small stack: record markers, no live read. */
const plunge: EngineGraphDocument = {
  version: 1,
  meta: {
    engineGraph: {
      format: 1,
      engine: { name: "plunge", version: "3.272.0-plunge.1" },
      scope: { kind: "stack", project: "app", stack: "dev" },
      observedAt: "2026-10-26T12:00:00Z",
      markerScheme: {
        ownerKey: "plunge-stack",
        addressKey: "plunge-urn",
        continuationKeys: ["plunge-urn-2", "plunge-urn-3", "plunge-urn-4"],
        encoding: { tags: "plain", labels: "digest" },
      },
    },
  },
  nodes: [
    {
      id: `${URN}pulumi:providers:aws::default`,
      kind: "pulumi:providers:aws",
      lexicon: "pulumi",
      attrs: { address: `${URN}pulumi:providers:aws::default` },
      facts: { ownership: "bound", ownedBy: "record", observedAt: "2026-10-26T12:00:00Z" },
    },
    {
      id: `${URN}aws:s3/bucketV2:BucketV2::assets`,
      kind: "aws:s3/bucketV2:BucketV2",
      lexicon: "pulumi",
      attrs: { address: `${URN}aws:s3/bucketV2:BucketV2::assets` },
      physicalId: "assets-4f1c2e9",
      facts: {
        ownership: "bound",
        ownedBy: "marker",
        markers: { owner: "app/dev", address: "aws:s3/bucketV2:BucketV2::assets", encoding: "plain", source: "record" },
        cloudIds: [
          { kind: "provider-id", value: "assets-4f1c2e9" },
          { kind: "arn", value: "arn:aws:s3:::assets-4f1c2e9" },
        ],
        recordVersions: {
          kept: true,
          versions: [{ id: "000003", writtenAt: "2026-10-26T11:40:00Z", current: true, deleted: false }],
        },
        observedAt: "2026-10-26T12:00:00Z",
      },
    },
    {
      id: `${URN}gcp:storage/bucket:Bucket::media`,
      kind: "gcp:storage/bucket:Bucket",
      lexicon: "pulumi",
      attrs: { address: `${URN}gcp:storage/bucket:Bucket::media` },
      physicalId: "media-9a0b",
      facts: {
        ownership: "bound",
        ownedBy: "marker",
        markers: { owner: "3f2a9c0d41b7e6a1", address: "9c41e0b7d2a85f3e6b1c0d9a7e4f2b18", encoding: "digest", source: "record" },
        cloudIds: [
          { kind: "provider-id", value: "media-9a0b" },
          { kind: "self-link", value: "https://www.googleapis.com/storage/v1/b/media-9a0b" },
        ],
        recordVersions: { kept: false, versions: [] },
        observedAt: "2026-10-26T12:00:00Z",
      },
    },
    {
      id: `${URN}aws:s3/bucketPolicy:BucketPolicy::assets-policy`,
      kind: "aws:s3/bucketPolicy:BucketPolicy",
      lexicon: "pulumi",
      attrs: { address: `${URN}aws:s3/bucketPolicy:BucketPolicy::assets-policy` },
      facts: { ownership: "pending", ownedBy: "record", observedAt: "2026-10-26T12:00:00Z" },
    },
  ],
  edges: [
    { from: `${URN}aws:s3/bucketPolicy:BucketPolicy::assets-policy`, to: `${URN}aws:s3/bucketV2:BucketV2::assets`, kind: "ref", viaAttr: "dependencies", grain: "instance" },
    { from: `${URN}aws:s3/bucketPolicy:BucketPolicy::assets-policy`, to: `${URN}aws:s3/bucketV2:BucketV2::assets`, kind: "ref", viaAttr: "bucket", grain: "property" },
    { from: `${URN}aws:s3/bucketV2:BucketV2::assets`, to: `${URN}pulumi:providers:aws::default`, kind: "ref", viaAttr: "provider", grain: "instance" },
  ],
  groups: {},
};

const cloudScope: CloudIndexScope = {
  kind: "cloud",
  substrate: "aws",
  scopeId: "000000000000",
  locations: ["us-east-1"],
  types: ["AWS::S3::Bucket", "AWS::SQS::Queue"],
};

const indexBody: Pick<IndexDocument, "graph" | "coverage"> = {
  coverage: [
    { listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" },
    { listedType: "AWS::SQS::Queue", location: "us-east-1", verdict: "read-failed", detail: "ListResources returned UnsupportedOperation" },
  ],
  graph: {
    version: 1,
    nodes: [
      {
        id: "aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs",
        kind: "AWS::S3::Bucket",
        lexicon: "aws",
        attrs: { BucketName: "web-logs" },
        physicalId: "web-logs",
      },
    ],
    edges: [],
    groups: { byLexicon: { aws: ["aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs"] } },
  },
};

/** One `behold index aws` version over one account and region. */
const index: IndexDocument = {
  index: "v1",
  stamp: {
    source: { kind: "cloud", name: "behold-lister", version: "0.0.0" },
    scope: cloudScope,
    scopeKey: indexScopeKey(cloudScope),
    observedAt: "2026-10-26T12:00:00Z",
    completedAt: "2026-10-26T12:00:04Z",
    digest: indexDocumentDigest(indexBody),
  },
  ...indexBody,
  notes: [{ kind: "no-catalog", message: "no reference catalog for AWS::SQS::Queue", listedType: "AWS::SQS::Queue" }],
};

/** Each fixture by file name (without `.json`). */
export const GRAPH_SCHEMA_FIXTURES = {
  "choudoufu.engine-graph": choudoufu,
  "plunge.engine-graph": plunge,
  index,
} as const;

/** The `$defs` entry each fixture validates against. */
export const GRAPH_SCHEMA_FIXTURE_DEFS: Record<keyof typeof GRAPH_SCHEMA_FIXTURES, "EngineGraphDocument" | "IndexDocument"> = {
  "choudoufu.engine-graph": "EngineGraphDocument",
  "plunge.engine-graph": "EngineGraphDocument",
  index: "IndexDocument",
};
