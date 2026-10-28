/**
 * Review stacks (INTENTIUS/plywood#15): `pr-<n>` stacks made from a
 * template stack's config and removed when their pull request closes or
 * their TTL passes. These run the three fixed forms of
 * `PULUMI_REVIEW_STACK_COMMANDS` (`./run.ts`), on review stack names only,
 * so nothing here can touch any other stack.
 *
 * - {@link initReviewStack}: `stack init <pr-stack> --no-select
 *   --copy-config-from <template>`. A stack that already exists is not an
 *   error: the next preview and `up` update it.
 * - {@link removeReviewStack}: `destroy --yes --json --stack <pr-stack>`,
 *   then `stack rm --yes --stack <pr-stack>`. A stack that is already gone
 *   is not an error, so a sweep that runs twice removes nothing twice.
 *
 * Who decides when they run is chant core's pull request environment
 * (`ci.prEnvironment`, its records on the workspace ledger and its TTL
 * sweep); these are the engine half only.
 */
import {
  defaultPlungeRunner,
  defaultPulumiRunner,
  isReviewStackName,
  pulumiRunFailure,
  reviewStackDestroyArgs,
  reviewStackInitArgs,
  reviewStackRmArgs,
  runReviewStackPlunge,
  runReviewStackPulumi,
  type PulumiRunner,
} from "./run";
import type { PulumiMemberEngine } from "./member-engine";

export interface ReviewStackOptions {
  /** The program's directory, where `Pulumi.yaml` is. */
  dir: string;
  /** The review stack, `pr-<n>` (or `pr-<n>-<suffix>`). */
  stack: string;
  engine?: PulumiMemberEngine;
  /** Injected for tests; default the engine's binary. */
  run?: PulumiRunner;
  env?: Record<string, string>;
}

export interface ReviewStackOutcome {
  stack: string;
  /** `created`, or `exists` when the stack was there already; `removed`, or `absent` when it was gone. */
  status: "created" | "exists" | "removed" | "absent";
}

const ALREADY = /already exists/i;
const MISSING = /no stack named|not found|does not exist/i;

function runner(opts: ReviewStackOptions): (args: string[]) => Promise<{ stdout: string }> {
  const plunge = opts.engine === "plunge";
  const run = opts.run ?? (plunge ? defaultPlungeRunner : defaultPulumiRunner);
  return (args) => (plunge ? runReviewStackPlunge : runReviewStackPulumi)(run, args, opts.dir, opts.env);
}

function said(err: unknown): string {
  const f = pulumiRunFailure(err);
  return [f.stderr, f.stdout, f.message].filter(Boolean).join("\n");
}

function refuseName(stack: string): void {
  if (!isReviewStackName(stack)) throw new Error(`"${stack}" is not a review stack name (pr-<n>); chant creates and removes review stacks only`);
}

/** Create the review stack from `template`'s config, or find it there already. */
export async function initReviewStack(opts: ReviewStackOptions & { template?: string }): Promise<ReviewStackOutcome> {
  refuseName(opts.stack);
  try {
    await runner(opts)(reviewStackInitArgs({ stack: opts.stack, ...(opts.template ? { copyConfigFrom: opts.template } : {}) }));
    return { stack: opts.stack, status: "created" };
  } catch (err) {
    if (ALREADY.test(said(err))) return { stack: opts.stack, status: "exists" };
    throw err;
  }
}

/** Destroy the review stack's resources and remove it, or find it gone already. */
export async function removeReviewStack(opts: ReviewStackOptions): Promise<ReviewStackOutcome> {
  refuseName(opts.stack);
  const run = runner(opts);
  try {
    await run(reviewStackDestroyArgs({ stack: opts.stack }));
  } catch (err) {
    if (MISSING.test(said(err))) return { stack: opts.stack, status: "absent" };
    throw err;
  }
  await run(reviewStackRmArgs({ stack: opts.stack }));
  return { stack: opts.stack, status: "removed" };
}
