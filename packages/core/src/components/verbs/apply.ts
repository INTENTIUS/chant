/**
 * apply family — the most cloud-shaped family (see docs/components/cloud-boundary).
 * AWS leaves for this starter set: cfn-deploy, ecs-update-service,
 * lambda-deploy, s3-sync, cdn-invalidate, run-migration.
 *
 * `cfn-deploy` carries declarative safety options (changeset preview,
 * `onReplace`, `stageGsi`) — sticky per-resource knowledge (a DynamoDB GSI
 * updates one at a time; a key-schema change forces replacement) lives inside
 * the capability, configured by options, never scripted per component. See
 * docs/components/capabilities.mdx#stickiness-lives-in-the-capability.
 *
 * Typed stubs only; see ../capability.ts for the "no cloud implementation yet" contract.
 */

import type { Capability } from "../capability";
import { stubCapability } from "./stub";

// ── cfn-deploy ───────────────────────────────────────────────────────────────

/**
 * How `cfn-deploy` handles a changeset that requires resource replacement.
 * - `block`: refuse to apply; surface the changeset for human review.
 * - `allow`: apply the replacement as CloudFormation proposes it.
 * - `snapshot-first`: take a `snapshot-before` capture, then allow the replacement.
 */
export type CfnReplacePolicy = "block" | "allow" | "snapshot-first";

export interface CfnDeployInput {
  /** Stack name. */
  stack: string;
  /** Path to the template, or an archive-relative reference (`archive:search.template.json`). */
  template: string;
  /** Template parameters, including wired references (e.g. `imageRef: "@Publish.digest"`). */
  inputs?: Record<string, string>;
  /** Preview the changeset before applying. Default: true. */
  previewChangeset?: boolean;
  /** Replacement safety policy. Default: "block". */
  onReplace?: CfnReplacePolicy;
  /** Stage DynamoDB GSI changes (add-then-backfill-then-remove) instead of an in-place replace. Default: false. */
  stageGsi?: boolean;
}

export interface CfnDeployOutput {
  /** Final stack status (`CREATE_COMPLETE`, `UPDATE_COMPLETE`, ...). */
  stackStatus: string;
  /** Stack outputs, available to downstream steps/components. */
  outputs: Record<string, string>;
}

/** Deploy a CloudFormation stack, with declarative replacement/GSI safety options. */
export const cfnDeploy: Capability<CfnDeployInput, CfnDeployOutput> = stubCapability(
  "cfn-deploy",
  { rollback: true },
);

// ── ecs-update-service ──────────────────────────────────────────────────────

export interface EcsUpdateServiceInput {
  /** ECS cluster name or ARN. */
  cluster: string;
  /** ECS service name. */
  service: string;
  /** Task definition/image reference to roll out (e.g. `"@Publish.digest"`). */
  imageRef?: string;
  /** Desired task count. Omit to leave unchanged. */
  desiredCount?: number;
  /** Force a new deployment even if the task definition is unchanged. Default: false. */
  forceNewDeployment?: boolean;
}

export interface EcsUpdateServiceOutput {
  /** ARN of the new/updated service deployment. */
  deploymentId: string;
}

/** Roll a new task definition/image out to an ECS service. */
export const ecsUpdateService: Capability<EcsUpdateServiceInput, EcsUpdateServiceOutput> =
  stubCapability("ecs-update-service", { rollback: true });

// ── lambda-deploy ────────────────────────────────────────────────────────────

export interface LambdaDeployInput {
  /** Function name or ARN. */
  functionName: string;
  /** Reference to the packaged code (e.g. `"@Publish.uri"` for an S3 zip, or an image URI). */
  codeRef: string;
  /** Publish a new immutable version after updating code. Default: true. */
  publish?: boolean;
  /** Alias to repoint at the new version (e.g. "live"). */
  alias?: string;
}

export interface LambdaDeployOutput {
  /** Published function version. */
  version: string;
  /** Function ARN (version-qualified if `publish` was true). */
  functionArn: string;
}

/** Update a Lambda function's code and optionally publish a version/move an alias. */
export const lambdaDeploy: Capability<LambdaDeployInput, LambdaDeployOutput> = stubCapability(
  "lambda-deploy",
  { rollback: true },
);

// ── s3-sync ──────────────────────────────────────────────────────────────────

export interface S3SyncInput {
  /** Local path or archive-relative path to sync from. */
  from: string;
  /** Destination S3 URI (e.g. `s3://bucket/prefix`). */
  to: string;
  /** Delete destination keys not present in the source. Default: false. */
  delete?: boolean;
}

export interface S3SyncOutput {
  /** Number of objects uploaded. */
  uploaded: number;
  /** Number of objects deleted (when `delete: true`). */
  deleted: number;
}

/** Sync a directory of static assets to an S3 bucket. */
export const s3Sync: Capability<S3SyncInput, S3SyncOutput> = stubCapability("s3-sync");

// ── cdn-invalidate ───────────────────────────────────────────────────────────

export interface CdnInvalidateInput {
  /** CloudFront distribution id. */
  distributionId: string;
  /** Path patterns to invalidate. Default: `["/*"]`. */
  paths?: string[];
}

export interface CdnInvalidateOutput {
  /** Invalidation batch id, for polling completion. */
  invalidationId: string;
}

/** Invalidate CDN cache paths after a content update (e.g. following `s3-sync`). */
export const cdnInvalidate: Capability<CdnInvalidateInput, CdnInvalidateOutput> = stubCapability(
  "cdn-invalidate",
);

// ── run-migration ────────────────────────────────────────────────────────────

export interface RunMigrationInput {
  /** Migration tool/runner identifier (e.g. "flyway", "prisma", "custom"). */
  tool: string;
  /** Where the migration runs (e.g. an ECS task, a host via `remote-exec`, a Lambda invoke). */
  target: string;
  /** Reference to the migration artifact (e.g. `"@Publish.digest"` for a migration image). */
  artifactRef?: string;
}

export interface RunMigrationOutput {
  /** True if any migrations were applied (false if already up to date). */
  applied: boolean;
  /** Migration version/checksum reached. */
  version: string;
}

/** Run a database/schema migration against a target as a deploy step. */
export const runMigration: Capability<RunMigrationInput, RunMigrationOutput> = stubCapability(
  "run-migration",
  { rollback: true },
);
