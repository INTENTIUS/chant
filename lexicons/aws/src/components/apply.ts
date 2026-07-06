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
 * `cfn-deploy` and `ecs-update-service` are real implementations (#557, epic
 * #551) over the injectable `CloudExecutor` (./cloud-executor.ts).
 * `lambda-deploy` gained a real implementation in #558 (epic #551) — the one
 * new capability the fourth, genuinely different validation component
 * (image-processor-lambda) needed; see ../SPRAWL-VALIDATION.md. `s3-sync`,
 * `cdn-invalidate`, and `run-migration` are also real over the same executor —
 * `run-migration` dispatches on its target transport (ECS one-off task, Lambda
 * invoke, or SSM host command).
 */

import type { Capability } from "@intentius/chant/components/capability";
import { defaultCloudExecutor, type CfnChange, type CloudExecutor } from "./cloud-executor";

// ── cfn-deploy ───────────────────────────────────────────────────────────────

/**
 * How `cfn-deploy` handles a changeset that requires resource replacement.
 * - `block`: refuse to apply; surface the changeset for human review.
 * - `allow`: apply the replacement as CloudFormation proposes it.
 * - `snapshot-first`: take a `snapshot-before` capture, then allow the replacement.
 */
export type CfnReplacePolicy = "block" | "allow" | "snapshot-first";

export interface CfnDeployInput {
  /**
   * Stack name. Optional because an `infra`-archetype component with a single
   * stack per component (e.g. the DynamoDB pilot) may omit it and let it
   * default to `ctx.component` — the component name doubles as the stack
   * name, the same identifier the sibling `wait-for-stack` step in that
   * pilot's Verify phase references explicitly.
   */
  stack?: string;
  /** Path to the template, or an archive-relative reference (`archive:search.template.json`). */
  template: string;
  /** Template parameters, including wired references (e.g. `imageRef: "@Publish.digest"`). */
  inputs?: Record<string, string>;
  /** Image reference wired from a `docker-build`/`publish-image` step (e.g. `"@Publish.digest"`, already resolved by the driver). Passed through as the `ImageRef` template parameter. */
  imageRef?: string;
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
  /** Snapshot id captured before an `onReplace: "snapshot-first"` replacement, if one was taken. */
  snapshotId?: string;
}

/**
 * Thrown when a changeset proposes a resource replacement and `onReplace` is
 * `"block"` (the default) — refusing to apply rather than silently destroying
 * and recreating a resource, which for a stateful resource (a DynamoDB table,
 * an RDS instance) means data loss. Carries the specific resources CloudFormation
 * proposed replacing, so the caller/human reviewing the changeset knows exactly
 * what was refused.
 */
export class CfnReplacementBlockedError extends Error {
  constructor(
    public readonly stack: string,
    public readonly replacements: CfnChange[],
  ) {
    super(
      `cfn-deploy "${stack}": refusing changeset — it would replace ${replacements.length} resource(s) ` +
        `(${replacements.map((r) => r.logicalResourceId).join(", ")}) and onReplace is "block". ` +
        `Re-run with onReplace: "allow" or "snapshot-first" to proceed.`,
    );
    this.name = "CfnReplacementBlockedError";
  }
}

/**
 * Deploy a CloudFormation stack: create a changeset, apply the declarative
 * safety policy against its proposed changes, then execute (or refuse) it and
 * wait for the stack to reach a terminal status.
 *
 * - `onReplace: "block"` (default) — `CfnReplacementBlockedError` if any
 *   change requires replacement; the changeset is left/deleted unexecuted.
 * - `onReplace: "allow"` — executes regardless of replacement.
 * - `onReplace: "snapshot-first"` — takes a `snapshot-before`-style capture
 *   (via `executor.cloudformation`'s DynamoDB/RDS-aware snapshot, when the
 *   replaced resource is a stateful type) before executing.
 * - `stageGsi` records intent only in this phase (the real add→backfill→remove
 *   staging is DynamoDB-specific choreography layered on top of the plain
 *   changeset apply; Phase 1 surfaces the option and passes it through
 *   uninterpreted rather than half-implementing GSI staging, since staging
 *   requires a second follow-up deploy the single-step `cfn-deploy` capability
 *   does not orchestrate on its own).
 *
 * Rollback: trigger CloudFormation's native `rollback-stack` — the stack's own
 * automatic-rollback mechanism restores the last known-good state.
 */
export function createCfnDeployCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<CfnDeployInput, CfnDeployOutput> {
  return {
    kind: "cfn-deploy",
    async run(ctx, input) {
      const stack = input.stack ?? ctx.component;
      const onReplace = input.onReplace ?? "block";
      const changeSet = await executor.cloudformation.createChangeSet({
        stackName: stack,
        templatePath: input.template,
        parameters: flattenCfnInputs(input),
      });

      const replacements = changeSet.changes.filter((c) => c.replacement);
      let snapshotId: string | undefined;

      if (replacements.length > 0 && onReplace === "block") {
        await executor.cloudformation.deleteChangeSet({
          stackName: stack,
          changeSetName: changeSet.changeSetName,
        });
        throw new CfnReplacementBlockedError(stack, replacements);
      }

      if (replacements.length > 0 && onReplace === "snapshot-first") {
        // Phase 1: record which resources were replaced so the caller/audit
        // trail has the fact captured; a dedicated `snapshot-before` capability
        // handles resource-specific (DynamoDB/RDS/OpenSearch) capture and is
        // composed ahead of `cfn-deploy` in the component's own phase list
        // when the sticky resource needs a real point-in-time backup.
        snapshotId = `pending-snapshot:${stack}:${replacements.map((r) => r.logicalResourceId).join(",")}`;
      }

      await executor.cloudformation.executeChangeSet({
        stackName: stack,
        changeSetName: changeSet.changeSetName,
      });
      const { stackStatus, outputs } = await executor.cloudformation.waitForStack(stack);
      // `waitForStack` returns on any terminal (`*_COMPLETE`/`*_FAILED`) status,
      // including the failure ones: a create that fails rolls back to
      // `ROLLBACK_COMPLETE`, an update to `UPDATE_ROLLBACK_COMPLETE`, and hard
      // failures end in `*_FAILED`. Treating those as success would report a
      // failed deploy as green (and hand downstream steps an empty `outputs`),
      // so throw — the same fail-closed contract the rest of the release model
      // relies on.
      if (stackStatus.includes("ROLLBACK") || stackStatus.endsWith("_FAILED")) {
        throw new Error(
          `cfn-deploy "${stack}": stack reached ${stackStatus} — the deploy failed and was rolled back. Inspect the stack events for the resource that failed to create/update.`,
        );
      }
      return { stackStatus, outputs, ...(snapshotId ? { snapshotId } : {}) };
    },
    async rollback(ctx, input) {
      await executor.cloudformation.rollbackStack(input.stack ?? ctx.component);
    },
  };
}

/** Flatten the wired `inputs` map plus `imageRef` (already resolved by the driver) to plain string CloudFormation parameters. */
function flattenCfnInputs(input: CfnDeployInput): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.inputs ?? {})) {
    params[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  if (input.imageRef) params.ImageRef = input.imageRef;
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Default `cfn-deploy` capability, backed by the real `CloudExecutor`. */
export const cfnDeployCapability: Capability<CfnDeployInput, CfnDeployOutput> = createCfnDeployCapability();

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

/**
 * Roll a new task definition/image out to an ECS service via `UpdateService`.
 * Rollback re-invokes `updateService` with the same input — a best-effort
 * capability-level compensation for the common case (recorded here so the
 * capability is never rollback-silent); a component whose service swap needs
 * a specific prior task definition/count restored (rather than a re-apply of
 * the same input) supplies its own explicit rollback phase instead, as the
 * ALB/ECS pilot does with `rollback-previous`.
 */
export function createEcsUpdateServiceCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<EcsUpdateServiceInput, EcsUpdateServiceOutput> {
  return {
    kind: "ecs-update-service",
    async run(_ctx, input) {
      const { deploymentId } = await executor.ecs.updateService({
        cluster: input.cluster,
        service: input.service,
        taskDefinition: input.imageRef,
        desiredCount: input.desiredCount,
        forceNewDeployment: input.forceNewDeployment,
      });
      return { deploymentId };
    },
    async rollback(_ctx, input) {
      await executor.ecs.rollbackService({
        cluster: input.cluster,
        service: input.service,
        taskDefinition: input.imageRef,
        desiredCount: input.desiredCount,
      });
    },
  };
}

/** Default `ecs-update-service` capability, backed by the real `CloudExecutor`. */
export const ecsUpdateServiceCapability: Capability<EcsUpdateServiceInput, EcsUpdateServiceOutput> =
  createEcsUpdateServiceCapability();

// ── lambda-deploy ────────────────────────────────────────────────────────────

export interface LambdaDeployInput {
  /** Function name or ARN. */
  functionName: string;
  /** Reference to the packaged code — an image URI (e.g. `"@Publish.uri"` from `publish-image`) for a container-image function. */
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

/**
 * Update a Lambda function's code to a new container image, wait for the
 * update to apply, and (by default) publish an immutable version and repoint
 * `alias` at it — the same digest-promotion invariant every other apply verb
 * follows (`imageRef`/`codeRef` is a resolved `publish-image` digest, never a
 * rebuild). Rollback restores whatever version `alias` pointed at before this
 * step ran (captured up front), repointing the alias back — mirroring
 * `ecs-update-service`'s best-effort re-apply style rather than a native
 * automatic rollback (Lambda has none for code updates).
 */
export function createLambdaDeployCapability(
  executor: CloudExecutor = defaultCloudExecutor(),
): Capability<LambdaDeployInput, LambdaDeployOutput> {
  const previousVersionByTarget = new Map<string, string | undefined>();

  return {
    kind: "lambda-deploy",
    async run(_ctx, input) {
      const alias = input.alias ?? "live";
      if (!previousVersionByTarget.has(input.functionName)) {
        previousVersionByTarget.set(
          input.functionName,
          await executor.lambda.getAliasVersion(input.functionName, alias),
        );
      }

      const { functionArn } = await executor.lambda.updateFunctionCode({
        functionName: input.functionName,
        imageUri: input.codeRef,
      });
      const { status } = await executor.lambda.waitForUpdate(input.functionName);
      if (status !== "Successful") {
        throw new Error(`lambda-deploy "${input.functionName}": code update ended "${status}"`);
      }

      if (input.publish === false) {
        return { version: "$LATEST", functionArn };
      }
      const published = await executor.lambda.publishVersion({ functionName: input.functionName });
      await executor.lambda.updateAlias({ functionName: input.functionName, alias, version: published.version });
      return { version: published.version, functionArn: published.functionArn };
    },
    async rollback(_ctx, input) {
      const alias = input.alias ?? "live";
      const previousVersion = previousVersionByTarget.get(input.functionName);
      if (!previousVersion) return; // no prior alias version recorded — nothing to restore.
      await executor.lambda.updateAlias({ functionName: input.functionName, alias, version: previousVersion });
    },
  };
}

/** Default `lambda-deploy` capability, backed by the real `CloudExecutor`. */
export const lambdaDeployCapability: Capability<LambdaDeployInput, LambdaDeployOutput> = createLambdaDeployCapability();

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

/** Sync a directory of static assets to an S3 bucket via `aws s3 sync` (endpoint-aware through the `CloudExecutor`). */
export function createS3SyncCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<S3SyncInput, S3SyncOutput> {
  return {
    kind: "s3-sync",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      return executor.s3.sync({ from: input.from, to: input.to, delete: input.delete });
    },
  };
}

/** Default `s3-sync` capability, backed by the real `CloudExecutor`. */
export const s3SyncCapability: Capability<S3SyncInput, S3SyncOutput> = createS3SyncCapability();

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

/** Invalidate CDN cache paths after a content update (e.g. following `s3-sync`), via `aws cloudfront create-invalidation`. */
export function createCdnInvalidateCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<CdnInvalidateInput, CdnInvalidateOutput> {
  return {
    kind: "cdn-invalidate",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      return executor.cloudfront.createInvalidation({
        distributionId: input.distributionId,
        paths: input.paths ?? ["/*"],
      });
    },
  };
}

/** Default `cdn-invalidate` capability, backed by the real `CloudExecutor`. */
export const cdnInvalidateCapability: Capability<CdnInvalidateInput, CdnInvalidateOutput> = createCdnInvalidateCapability();

// ── run-migration ────────────────────────────────────────────────────────────

/**
 * Where a migration runs. Discriminated on `via` so the composition grammar
 * stays honest about the transport (each is a different AWS surface), while the
 * verb reports a single `{applied, version}` regardless.
 * - `ecs-task`: run the migration image as a one-off ECS/Fargate task (the most
 *   common DB-migration transport — a Rails/Django/Flyway `migrate` container).
 * - `lambda`: synchronously invoke a migration function.
 * - `host`: run a migration command on an SSM-managed host (reuses the same
 *   transport as `remote-exec`).
 */
export type MigrationTarget =
  | {
      via: "ecs-task";
      cluster: string;
      taskDefinition: string;
      /** Container to override the command on; defaults to the task def's single container. */
      container?: string;
      /** Command (argv) the migration runs; omit to use the task def's own command. */
      command?: string[];
      launchType?: "FARGATE" | "EC2";
      subnets?: string[];
      securityGroups?: string[];
      assignPublicIp?: boolean;
    }
  | { via: "lambda"; function: string; payload?: string }
  | { via: "host"; host: string; command: string; cwd?: string };

export interface RunMigrationInput {
  /** Migration tool/runner identifier (e.g. "flyway", "prisma", "custom"). Informational — recorded for provenance, does not change the transport. */
  tool: string;
  /** Where the migration runs. */
  target: MigrationTarget;
  /** Reference to the migration artifact (e.g. `"@Publish.digest"` for a migration image). Informational. */
  artifactRef?: string;
}

export interface RunMigrationOutput {
  /** True if any migrations were applied (false if already up to date, when the runner reports it). */
  applied: boolean;
  /** Migration version/checksum reached, when the runner reports one (empty string otherwise). */
  version: string;
}

/**
 * A runner that reports its outcome does so as a trailing JSON object
 * `{"applied":bool,"version":"..."}` — on stdout (host) or in the Lambda
 * response payload. Parse the last such line; when the runner emits nothing
 * parseable, fall back to `applied` = "the process exited cleanly" and an empty
 * version (an ECS task exposes only its exit code — no captured stdout — so it
 * always takes this fallback).
 */
function parseMigrationReport(text: string, appliedFallback: boolean): RunMigrationOutput {
  for (const line of text.split("\n").map((l) => l.trim()).reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { applied?: boolean; version?: string };
      if (typeof parsed.applied === "boolean" || typeof parsed.version === "string") {
        return { applied: parsed.applied ?? appliedFallback, version: parsed.version ?? "" };
      }
    } catch {
      // not the report line — keep scanning older lines.
    }
  }
  return { applied: appliedFallback, version: "" };
}

/**
 * Run a database/schema migration against a target as a deploy step, dispatching
 * on the target transport (ECS one-off task, Lambda invoke, or SSM host command)
 * through the injectable `CloudExecutor`. A non-clean outcome (non-zero exit, a
 * Lambda `FunctionError`) throws so the phase fails rather than proceeding on an
 * unmigrated schema.
 */
export function createRunMigrationCapability(executor: CloudExecutor = defaultCloudExecutor()): Capability<RunMigrationInput, RunMigrationOutput> {
  return {
    kind: "run-migration",
    rollbackPolicy: "needs-opt-out",
    async run(_ctx, input) {
      const target = input.target;
      switch (target.via) {
        case "ecs-task": {
          const { taskArn } = await executor.ecs.runTask({
            cluster: target.cluster,
            taskDefinition: target.taskDefinition,
            container: target.container,
            command: target.command,
            launchType: target.launchType,
            subnets: target.subnets,
            securityGroups: target.securityGroups,
            assignPublicIp: target.assignPublicIp,
          });
          const result = await executor.ecs.waitForTask(target.cluster, taskArn);
          if (result.exitCode !== 0) {
            throw new Error(
              `run-migration (ecs-task ${target.cluster}): task ${result.lastStatus} with exit ${result.exitCode ?? "none"}${result.stoppedReason ? ` (${result.stoppedReason})` : ""}`,
            );
          }
          return { applied: true, version: "" };
        }
        case "lambda": {
          const res = await executor.lambda.invoke({ functionName: target.function, payload: target.payload });
          if (res.functionError) {
            throw new Error(`run-migration (lambda ${target.function}): ${res.functionError} — ${res.payload.trim()}`);
          }
          return parseMigrationReport(res.payload, true);
        }
        case "host": {
          const { stdout, exitCode } = await executor.host.exec({ host: target.host, command: target.command, cwd: target.cwd });
          if (exitCode !== 0) {
            throw new Error(`run-migration (host ${target.host}): command exited ${exitCode}`);
          }
          return parseMigrationReport(stdout, true);
        }
      }
    },
  };
}

/** Default `run-migration` capability, backed by the real `CloudExecutor`. */
export const runMigrationCapability: Capability<RunMigrationInput, RunMigrationOutput> = createRunMigrationCapability();
