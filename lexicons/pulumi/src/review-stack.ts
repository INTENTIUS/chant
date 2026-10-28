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
 * sweep); these are the engine half only (#4609):
 *
 * - under `pr-<n>`, `pulumi-up` applies {@link reviewStackFor}'s stack,
 *   runs {@link initReviewStack} from {@link reviewConfigSource} before its
 *   first preview, and gives core the stack's location
 *   ({@link reviewStackLocation}) for the environment's record;
 * - `pr-env down` and the sweep run {@link reviewStackTeardown} over the
 *   record's locations;
 * - the plugin's `prEnvTemplate` takes a `<project>/<stack>` template
 *   ({@link pulumiTemplateStack}), so plywood's template needs no
 *   chant.config.ts environment of that name.
 */
import { isAbsolute, relative, resolve } from "node:path";
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
import type { PrEnvTeardownAdapter } from "@intentius/chant/components/pr-environment";
import type { TeardownCandidate, TeardownHole, TeardownOutcome } from "@intentius/chant/lexicon";

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

// ── the pull request environment (#4609) ────────────────────────────────────

/** A pull request's environment name, `pr-<n>`, as chant core names it. */
const PR_ENV = /^pr-([1-9][0-9]*)$/;

/** A review stack suffix: lowercase letters, digits and `-`, as {@link REVIEW_STACK_NAME} takes it. */
const SUFFIX = /^[a-z0-9][a-z0-9-]*$/;

/** A Pulumi organization, project or stack segment. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The pull request number of `pr-<n>`, or undefined for any other environment. */
export function prNumberOf(env: string | undefined): number | undefined {
  const m = typeof env === "string" ? PR_ENV.exec(env) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * The review stack a `pulumi-up` step applies in pull request environment
 * `env` (#4609): the step's stack with its last segment replaced by `env`
 * (and `-<suffix>` when given), so `acme/shop/dev` in `pr-12` is
 * `acme/shop/pr-12`. Undefined outside a pull request's environment.
 */
export function reviewStackFor(stack: string, env: string | undefined, suffix?: string): string | undefined {
  if (prNumberOf(env) === undefined) return undefined;
  if (suffix !== undefined && !SUFFIX.test(suffix)) throw new Error(`pulumi-up: reviewSuffix "${suffix}" is not lowercase letters, digits and "-"`);
  const parts = stack.split("/");
  const name = suffix ? `${env}-${suffix}` : env!;
  const review = [...parts.slice(0, -1), name].join("/");
  if (!isReviewStackName(review)) throw new Error(`pulumi-up: the review stack for "${stack}" in ${env} would be "${review}", which is not a review stack name`);
  return review;
}

/**
 * Whether `template` (`ci.prEnvironment.template`) names a Pulumi stack:
 * `<project>/<stack>`, as plywood's `review_stacks.template` is, or
 * `<org>/<project>/<stack>`. The parts, or undefined for any other form,
 * which is then a chant.config.ts environment as before.
 */
export function pulumiTemplateStack(template: string | undefined): { org?: string; project: string; stack: string } | undefined {
  if (typeof template !== "string") return undefined;
  const parts = template.split("/");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => SEGMENT.test(p))) return undefined;
  if (isReviewStackName(template)) return undefined;
  return parts.length === 3 ? { org: parts[0]!, project: parts[1]!, stack: parts[2]! } : { project: parts[0]!, stack: parts[1]! };
}

/**
 * The stack a review stack copies its config from (`--copy-config-from`):
 * the template's stack when the template names a stack of this project
 * (`project`, `Pulumi.yaml`'s name), else the step's own stack, which is the
 * stack the template environment applies. Never the review stack itself.
 */
export function reviewConfigSource(step: { stack: string; project?: string }, template: string | undefined, review: string): string | undefined {
  const named = pulumiTemplateStack(template);
  let from = step.stack;
  if (named && step.project !== undefined && named.project === step.project) {
    // A two-part template is project/stack, which Pulumi would read as org/stack: keep the step's own prefix.
    from = named.org ? template! : [...step.stack.split("/").slice(0, -1), named.stack].join("/");
  }
  return from === review ? undefined : from;
}

/** A review stack's location on the environment's record: `<engine>:<dir>#<stack>`, `dir` relative to the project root. */
export function reviewStackLocation(engine: PulumiMemberEngine, dir: string, stack: string): string {
  return `${engine}:${dir.split("\\").join("/") || "."}#${stack}`;
}

/** A location {@link reviewStackLocation} wrote, read back, or undefined when it does not read. */
export function parseReviewStackLocation(location: string): { engine: PulumiMemberEngine; dir: string; stack: string } | undefined {
  const m = /^(pulumi|plunge):([^#]+)#([^#\s]+)$/.exec(location.trim());
  return m ? { engine: m[1] as PulumiMemberEngine, dir: m[2]!, stack: m[3]! } : undefined;
}

/** The name `pr-env down` attributes review stack outcomes to; distinct from the lexicon's own, as core requires. */
export const REVIEW_STACK_TEARDOWN = "pulumi-review-stacks";

/** The candidate type of a review stack in a teardown. */
export const REVIEW_STACK_TYPE = "pulumi:pulumi:Stack";

/** The adapter's options: the project root, and runners for tests. */
export interface ReviewStackTeardownOptions {
  cwd: string;
  run?: PulumiRunner;
  plunge?: PulumiRunner;
  env?: Record<string, string>;
}

/** Core's `PrEnvTeardownAdapter` (a type only, so the lexicon bundles without core's pull request modules). */
export type ReviewStackTeardown = PrEnvTeardownAdapter;

/**
 * The review stacks a pull request's environment holds, as its record's
 * `locations` say, and their removal (#4609): `pr-env down` and the TTL
 * sweep run it through core's teardown, after core's ownership check.
 *
 * The locations came from the up job, which ran the change's code, so each
 * is checked as data first: it must read as `<engine>:<dir>#<stack>`, its
 * `dir` must stay inside the project root, and its stack must be a review
 * stack of this pull request (`pr-<n>` or `pr-<n>-<suffix>` for the record's
 * `n`). Anything else is a hole, so nothing outside is removed and the
 * environment stays live for a person to read. A review stack's marker is its
 * name, which only `pr-<n>`'s environment gives it, so the candidate carries
 * the environment's marker. Removal is {@link removeReviewStack}: destroy,
 * then `stack rm` without `--force`.
 */
export function reviewStackTeardown(opts: ReviewStackTeardownOptions): ReviewStackTeardown {
  const root = resolve(opts.cwd);
  const read = (pr: number, location: string): { engine: PulumiMemberEngine; dir: string; stack: string } | string => {
    const at = parseReviewStackLocation(location);
    if (!at) return `the location "${location}" does not read as <engine>:<dir>#<stack>`;
    const abs = resolve(root, at.dir);
    const rel = relative(root, abs);
    if (isAbsolute(at.dir) || rel.startsWith("..") || isAbsolute(rel)) return `the location "${location}" names a directory outside the project`;
    const last = at.stack.split("/").pop()!;
    if (!isReviewStackName(at.stack) || !(last === `pr-${pr}` || last.startsWith(`pr-${pr}-`))) return `the location "${location}" names a stack that is not a review stack of pull request ${pr}`;
    return { ...at, dir: abs };
  };
  const byName = new Map<string, { engine: PulumiMemberEngine; dir: string; stack: string }>();
  return {
    name: REVIEW_STACK_TEARDOWN,
    async owned(input) {
      const candidates: TeardownCandidate[] = [];
      const holes: TeardownHole[] = [];
      for (const [component, joined] of Object.entries(input.live.locations ?? {})) {
        for (const location of joined.split(",").map((l) => l.trim()).filter(Boolean)) {
          if (!location.startsWith("pulumi:") && !location.startsWith("plunge:")) continue;
          const at = read(input.live.pr, location);
          if (typeof at === "string") {
            holes.push({ name: `${component}: ${location}`, reason: "read-failed", type: REVIEW_STACK_TYPE, detail: at });
            continue;
          }
          const name = `${relative(root, at.dir).split("\\").join("/") || "."}#${at.stack}`;
          if (byName.has(name)) continue;
          byName.set(name, at);
          candidates.push({ name, type: REVIEW_STACK_TYPE, physicalId: at.stack, marker: { stack: input.marker.stack, env: input.environment } });
        }
      }
      return { candidates, ...(holes.length > 0 ? { holes } : {}) };
    },
    async teardown(input) {
      const outcomes: TeardownOutcome[] = [];
      for (const c of input.candidates) {
        const at = byName.get(c.name);
        if (!at) {
          outcomes.push({ name: c.name, outcome: "failed", detail: "not a review stack this teardown enumerated" });
          continue;
        }
        try {
          const run = at.engine === "plunge" ? opts.plunge : opts.run;
          const done = await removeReviewStack({ dir: at.dir, stack: at.stack, engine: at.engine, ...(run ? { run } : {}), ...(opts.env ? { env: opts.env } : {}) });
          outcomes.push({ name: c.name, outcome: "deleted", ...(done.status === "absent" ? { detail: "the stack was already gone" } : {}) });
        } catch (err) {
          outcomes.push({ name: c.name, outcome: "failed", detail: said(err) || String(err) });
        }
      }
      return { outcomes };
    },
  };
}
