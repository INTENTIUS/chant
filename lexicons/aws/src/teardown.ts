/**
 * Env teardown for the aws lexicon (chant #1222) — both halves of the
 * `teardownOwned` / `executeTeardown` capability pair, at STACK granularity.
 *
 * Per-resource selection is impossible here by construction: the thin read
 * (`describeResources`) is sourced from `describe-stack-resources`, which
 * returns no tags, so no resource-level marker can be read on the teardown
 * path. The stack is aws's ownership boundary anyway — the applier deploys
 * whole stacks and deletes ride CloudFormation — so teardown enumerates the
 * environment's stacks and verifies the marker on each STACK's own tags
 * (`DescribeStacks` → `Tags`), stamped there by the apply paths from the
 * template's `Metadata["chant:ownership"]` block.
 *
 * Which stacks are the environment's: the project's declared `stacks[]` when
 * it is a multi-stack project, else the single-stack convention — the explicit
 * `stack` option, else the stack named after the environment (the same rule
 * `describeResources` and `exportResources` apply, see chant #932).
 *
 * Verification is tag-reading, never name-trusting. A resolved stack whose
 * tags carry exactly the requested identity (managed-by + stack + env) is a
 * candidate of type `AWS::CloudFormation::Stack`. A stack carrying a DIFFERENT
 * marker identity verifiably belongs to another project or env — out of scope,
 * silently, the way another env's resources are. A stack carrying NO marker at
 * all is unknowable — a legacy chant stack from before stack tagging, or a
 * foreign stack that happens to hold the env's name — and is reported as a
 * hole (`filtered` / unverified-ownership), never deleted. An absent stack is
 * knowledge, not a hole: nothing to tear down.
 *
 * Execution re-reads each candidate stack's tags immediately before deleting
 * (the enumeration is a moment old at best, and a delete is not undoable),
 * then rides the existing Query-API delete — `awsDelete`, DeleteStack polled
 * to DELETE_COMPLETE. An identity that no longer matches is `not-prunable:
 * unverified-ownership`; an already-absent stack is `deleted` (teardown is
 * idempotent).
 */

import type {
  TeardownCandidate,
  TeardownEnumeration,
  TeardownExecution,
  TeardownHole,
  TeardownOutcome,
} from "@intentius/chant/lexicon";
import { readOwnership, type OwnershipMarker } from "@intentius/chant/ownership";
import { AWS_TAG_OWNERSHIP_KEYS } from "./ownership";
import {
  cfnQuery,
  xmlLeaves,
  xmlMembers,
  AwsReadError,
  type AwsReadClientOptions,
} from "./api/read-client";
import { awsDelete, type AwsHttp } from "./op/activities/aws-apply";

/** The one candidate type this lexicon's teardown produces: whole stacks. */
export const STACK_TYPE = "AWS::CloudFormation::Stack";

export interface AwsTeardownOptions {
  environment: string;
  /** The identity to select on: this project's ownership stack + the env being torn down. */
  marker: OwnershipMarker;
  /** Explicit deployed stack name (single-stack override). */
  stack?: string;
  /** Region that stack is deployed in. */
  region?: string;
  /** A multi-stack project's declared stacks (chant.config `stacks[]`). */
  stacks?: Array<{ name: string; region?: string }>;
}

/** Injectable transports/timeouts, so tests double the Query API (no network). */
export interface AwsTeardownDeps {
  /** Options for the read client's `DescribeStacks` calls (http injection, endpoint). */
  read?: AwsReadClientOptions;
  /** The applier transport `awsDelete` polls DeleteStack through. */
  applyHttp?: AwsHttp;
  /** DeleteStack settle timeout in ms (default `awsDelete`'s 300000). */
  timeoutMs?: number;
  /** DeleteStack poll interval in ms (default `awsDelete`'s 3000). */
  intervalMs?: number;
}

/** The stacks an env teardown resolves to: `stacks[]`, else the single-stack convention. */
export function resolveTeardownStacks(
  options: AwsTeardownOptions,
): Array<{ name: string; region?: string }> {
  if (options.stacks && options.stacks.length > 0) return options.stacks;
  return [
    {
      name: options.stack ?? options.environment,
      ...(options.region ? { region: options.region } : {}),
    },
  ];
}

/** One live stack, as DescribeStacks answers for it. */
interface LiveStack {
  stackId?: string;
  status?: string;
  /** The stack's own tags, as a flat map. */
  tags: Record<string, string>;
}

/** A DescribeStacks miss — CloudFormation's "does not exist" ValidationError. */
function isStackMissingError(err: unknown): boolean {
  return err instanceof AwsReadError && /does not exist/i.test(err.message);
}

/** `DescribeStacks` for one stack; `undefined` when the stack does not exist. */
async function describeStack(
  name: string,
  region: string | undefined,
  read: AwsReadClientOptions,
): Promise<LiveStack | undefined> {
  let xml: string;
  try {
    xml = await cfnQuery("DescribeStacks", { StackName: name }, {
      ...read,
      ...(region ? { region } : {}),
    });
  } catch (err) {
    if (isStackMissingError(err)) return undefined;
    throw err;
  }
  // One StackName queried → one stack member; `xmlLeaves` keeps the first
  // occurrence of each scalar, which is that stack's StackId/StackStatus.
  const leaves = xmlLeaves(xml);
  const tags: Record<string, string> = {};
  for (const m of xmlMembers(xml, "Tags")) {
    if (m.Key) tags[m.Key] = m.Value ?? "";
  }
  return {
    ...(leaves.StackId ? { stackId: leaves.StackId } : {}),
    ...(leaves.StackStatus ? { status: leaves.StackStatus } : {}),
    tags,
  };
}

/** True when a live stack's own tags carry exactly the requested identity. */
function matchesMarker(tags: Record<string, string>, marker: OwnershipMarker): boolean {
  const read = readOwnership(tags, AWS_TAG_OWNERSHIP_KEYS);
  return read !== undefined && read.stack === marker.stack && read.env === marker.env;
}

/**
 * Enumerate the environment's marker-verified stacks — the aws half of
 * `chant lifecycle teardown <env>` planning. Read-only.
 */
export async function teardownOwned(
  options: AwsTeardownOptions,
  deps: AwsTeardownDeps = {},
): Promise<TeardownEnumeration> {
  const read = deps.read ?? {};
  const candidates: TeardownCandidate[] = [];
  const holes: TeardownHole[] = [];

  for (const ref of resolveTeardownStacks(options)) {
    let live: LiveStack | undefined;
    try {
      live = await describeStack(ref.name, ref.region, read);
    } catch (err) {
      holes.push({
        name: ref.name,
        type: STACK_TYPE,
        reason: "read-failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // Absent is knowledge: the env-resolved stack does not exist, so there is
    // nothing to tear down and nothing unknown about it.
    if (live === undefined) continue;

    const identity = readOwnership(live.tags, AWS_TAG_OWNERSHIP_KEYS);
    if (identity !== undefined && identity.stack === options.marker.stack && identity.env === options.marker.env) {
      candidates.push({
        name: ref.name,
        type: STACK_TYPE,
        ...(live.stackId ? { physicalId: live.stackId } : {}),
        marker: identity,
      });
      continue;
    }
    if (identity !== undefined) {
      // A marker for a DIFFERENT identity is verifiably someone else's
      // (another project's stack, another env's deployment of a shared stack
      // name) — out of scope, the way any foreign-env resource is.
      continue;
    }
    // No marker at all: a legacy chant stack deployed before stack tagging, or
    // a foreign stack under the env's name — unknowable either way. Loud, and
    // never deleted (#1089): unverified ownership reads as "do not touch",
    // not as "clean".
    holes.push({
      name: ref.name,
      type: STACK_TYPE,
      reason: "filtered",
      detail:
        `unverified-ownership: the stack exists but its tags carry no chant ownership marker ` +
        `(expected ${AWS_TAG_OWNERSHIP_KEYS.managedBy} + ${AWS_TAG_OWNERSHIP_KEYS.stack}=${options.marker.stack}` +
        `${options.marker.env ? ` + ${AWS_TAG_OWNERSHIP_KEYS.env}=${options.marker.env}` : ""}) — ` +
        `a chant stack deployed before stack tagging, or a foreign stack; re-deploy to stamp it, it will not be deleted`,
    });
  }

  return { candidates, ...(holes.length > 0 ? { holes } : {}) };
}

/**
 * Delete the handed-over stacks: re-verify each stack's own tags, then
 * DeleteStack via `awsDelete`, polled to DELETE_COMPLETE. One outcome per
 * candidate, always.
 */
export async function executeTeardown(
  options: AwsTeardownOptions & { candidates: TeardownCandidate[] },
  deps: AwsTeardownDeps = {},
): Promise<TeardownExecution> {
  const read = deps.read ?? {};
  const regionByStack = new Map<string, string | undefined>(
    resolveTeardownStacks(options).map((s) => [s.name, s.region]),
  );

  const outcomes: TeardownOutcome[] = [];
  for (const candidate of options.candidates) {
    outcomes.push(await deleteStackCandidate(candidate, regionByStack.get(candidate.name), options.marker, read, deps));
  }
  return { outcomes };
}

async function deleteStackCandidate(
  candidate: TeardownCandidate,
  region: string | undefined,
  marker: OwnershipMarker,
  read: AwsReadClientOptions,
  deps: AwsTeardownDeps,
): Promise<TeardownOutcome> {
  const base = {
    name: candidate.name,
    type: STACK_TYPE,
    ...(candidate.physicalId ? { physicalId: candidate.physicalId } : {}),
  };

  // Re-read and re-verify the stack's own tags right before deleting: the
  // enumeration is a moment old at best, and a DeleteStack is not undoable.
  let live: LiveStack | undefined;
  try {
    live = await describeStack(candidate.name, region, read);
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  if (live === undefined || live.status === "DELETE_COMPLETE") {
    return { ...base, outcome: "deleted", detail: "already absent" };
  }
  if (!matchesMarker(live.tags, marker)) {
    return {
      ...base,
      outcome: "not-prunable",
      detail: "unverified-ownership: the live stack's tags no longer carry the requested marker identity",
    };
  }

  try {
    await awsDelete(
      {
        stackName: candidate.name,
        ...(region ? { region } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
      },
      undefined,
      deps.applyHttp,
    );
  } catch (err) {
    return { ...base, outcome: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { ...base, outcome: "deleted" };
}
