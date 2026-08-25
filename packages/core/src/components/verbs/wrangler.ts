/**
 * `wrangler-deploy` / `wrangler-versions-promote` — the Cloudflare Workers
 * apply leaves (chant #1293, epic #1296). The epic cedes the Workers plane
 * entirely to `wrangler` (first-party, schema-backed, already owns the
 * config format, bindings model, local dev, and deploy) — these two verbs
 * are a typed wrapper over that CLI, not a reimplementation of it.
 *
 * Placement: core, not a cloudflare lexicon. #1293's own analysis weighed
 * three options — core (generic verb, fastest, costs a little conceptual
 * tidiness since `wrangler-deploy` shells a specific vendor CLI), a
 * capability-only cloudflare lexicon (the "correct" home, but `LexiconPlugin`
 * tier-1 completeness — serializer, lint rules, post-synth, LSP, examples,
 * docs — is heavy ceremony for three verbs and no resource types), or
 * generalizing to a `cli-deploy` verb parameterised by tool (tempting, but
 * premature and it re-opens the verb set the bounded-primitives thesis
 * depends on staying closed). Core wins on the same precedent `sign`/
 * `attest-provenance` (./sign.ts) already set: a specific vendor CLI
 * (`cosign`) shelled out through the injectable `ProcessRunner`
 * (./process-runner.ts), no cloud-specific SDK client needed the way AWS's
 * `CloudExecutor` (./cloud-executor.ts) models CloudFormation/ECS/Lambda.
 * `wrangler` fits that exact shape. Revisit if/when the zone-plane lexicon
 * (#1294) lands and gives these three verbs a natural cloudflare-owned home.
 *
 * `wrangler-versions-promote` is also the direct evidence for #1296's
 * "three new verbs cover a whole new cloud" claim: Cloudflare's native
 * Worker version rollback maps onto the existing `RollbackPolicy: "native"`
 * (../capability.ts) with no compensation code to hand-write — both verbs
 * here declare a `rollback` (auto-derived "native" per ../capability.ts's
 * `Capability.rollbackPolicy` doc) that re-promotes to whichever version was
 * live before the step ran, the same best-effort captured-previous-state
 * pattern lexicons/aws/src/components/apply.ts's `lambda-deploy` uses for
 * its alias rollback.
 *
 * No real Cloudflare control-plane emulator exists yet (#1295, epic #1296),
 * so — like ./sign.ts — every real path here shells out through the
 * injectable `ProcessRunner` and every test substitutes `MockProcessRunner`
 * (./__tests__/mock-process-runner.ts): no live `wrangler`, no network, ever,
 * in a test run. CI coverage is plan-shape/invocation-shape assertions only,
 * per #1293's own "Verification" section.
 */

import type { Capability } from "../capability";
import { defaultProcessRunner, q, requireTool, type ProcessRunner } from "./process-runner";

const WRANGLER_TOOL = "wrangler";

/** Distinguishes one deploy target (a wrangler config + optional named environment) from another, so the best-effort previous-version tracking below never conflates two different Workers sharing a process. */
function targetKey(config: string, env?: string): string {
  return env ? `${config}#${env}` : config;
}

function buildWranglerDeployArgs(input: WranglerDeployInput): string {
  const args = ["wrangler", "deploy", "--config", q(input.config)];
  if (input.env) args.push("--env", q(input.env));
  return args.join(" ");
}

function buildVersionsListArgs(config: string, env?: string): string {
  const args = ["wrangler", "versions", "list", "--config", q(config), "--json"];
  if (env) args.push("--env", q(env));
  return args.join(" ");
}

function buildVersionsPromoteArgs(config: string, versionId: string, percentage: number, env?: string): string {
  const args = ["wrangler", "versions", "deploy", q(`${versionId}@${percentage}`), "--config", q(config), "--yes"];
  if (env) args.push("--env", q(env));
  return args.join(" ");
}

/** Thrown when `wrangler deploy`'s stdout carries no parseable Version ID — fail-closed rather than returning a capability output downstream steps (`wrangler-versions-promote`, wired via `"@Deploy.versionId"`) would silently receive as `undefined`. */
export class WranglerVersionIdNotFoundError extends Error {
  constructor(public readonly stdout: string) {
    super(`wrangler-deploy: could not find a Version ID in wrangler's output. Got:\n${stdout}`);
    this.name = "WranglerVersionIdNotFoundError";
  }
}

// wrangler's deploy/versions-upload output names the new version as e.g.
// "Version ID: 07bcb198-... " (gradual deployments) — accept either "Version
// ID:" or the bare "Version:" wording across wrangler versions, and require a
// UUID-shaped token so a stray "Version: 2" summary line can't be mistaken
// for it.
const VERSION_ID_RE = /Version(?: ID)?:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/** Extract the deployed Worker version id from `wrangler deploy`'s stdout. Exported so tests can assert on it directly, mirroring ./sign.ts's `buildSignArgs`. */
export function parseWranglerVersionId(stdout: string): string {
  const match = VERSION_ID_RE.exec(stdout);
  if (!match) throw new WranglerVersionIdNotFoundError(stdout);
  return match[1]!;
}

interface WranglerVersionsListEntry {
  id: string;
  percentage?: number;
}

/**
 * Best-effort: the currently-live (100%) version id, from `wrangler versions
 * list --json` — `undefined` for a first deploy (no versions yet) or if
 * listing fails/parses oddly. Never throws: capturing "what to roll back to"
 * must not block the deploy/promote itself, the same fail-soft stance
 * `lambda-deploy`'s alias-version capture takes.
 */
async function currentLiveVersionId(
  runner: ProcessRunner,
  config: string,
  env?: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runner.run(buildVersionsListArgs(config, env));
    const entries = JSON.parse(stdout) as WranglerVersionsListEntry[];
    return entries.find((entry) => entry.percentage === 100)?.id;
  } catch {
    return undefined;
  }
}

// ── wrangler-deploy ──────────────────────────────────────────────────────────

export interface WranglerDeployInput {
  /** Path to the Worker's `wrangler.jsonc`/`wrangler.toml`. */
  config: string;
  /** Named environment within the config (`wrangler deploy --env <env>`). */
  env?: string;
}

export interface WranglerDeployOutput {
  /** The version id wrangler assigned this deploy — wire into `wrangler-versions-promote` (e.g. `"@Deploy.versionId"`). */
  versionId: string;
}

/**
 * Deploy a Worker from a `wrangler.jsonc`/`wrangler.toml` via `wrangler
 * deploy`, and return the version id it published — the analogue of
 * `lambda-deploy` (../../lexicons/aws/src/components/apply.ts) for the
 * Workers plane.
 *
 * Rollback: `wrangler-versions-promote` back to whichever version was live
 * before this step ran (captured up front via `wrangler versions list`, the
 * same best-effort captured-previous pattern `lambda-deploy` uses for its
 * alias). A no-op on a first deploy — nothing was live to restore.
 */
export function createWranglerDeployCapability(
  processRunner: ProcessRunner = defaultProcessRunner(),
): Capability<WranglerDeployInput, WranglerDeployOutput> {
  const previousVersionByTarget = new Map<string, string | undefined>();

  return {
    kind: "wrangler-deploy",
    async run(_ctx, input) {
      await requireTool(processRunner, WRANGLER_TOOL, `deploy the Worker in ${input.config}`);
      const target = targetKey(input.config, input.env);
      if (!previousVersionByTarget.has(target)) {
        previousVersionByTarget.set(target, await currentLiveVersionId(processRunner, input.config, input.env));
      }

      const { stdout } = await processRunner.run(buildWranglerDeployArgs(input));
      return { versionId: parseWranglerVersionId(stdout) };
    },
    async rollback(_ctx, input) {
      const target = targetKey(input.config, input.env);
      const previousVersionId = previousVersionByTarget.get(target);
      if (!previousVersionId) return; // first deploy — nothing was live before it.
      await requireTool(processRunner, WRANGLER_TOOL, `roll back the Worker in ${input.config}`);
      await processRunner.run(buildVersionsPromoteArgs(input.config, previousVersionId, 100, input.env));
    },
  };
}

/** Default `wrangler-deploy` capability, backed by the real `ProcessRunner`. */
export const wranglerDeployCapability: Capability<WranglerDeployInput, WranglerDeployOutput> =
  createWranglerDeployCapability();

// ── wrangler-versions-promote ─────────────────────────────────────────────────

export interface WranglerVersionsPromoteInput {
  /** Path to the Worker's `wrangler.jsonc`/`wrangler.toml`. */
  config: string;
  /** Version id to promote — typically wired from a prior `wrangler-deploy` step (`"@Deploy.versionId"`) or a prior version id when this step composes as an explicit rollback. */
  versionId: string;
  /** Traffic percentage to route to `versionId`. Default: 100 (full promote/rollback). Below 100 is the gradual-deployment lever. */
  percentage?: number;
  /** Named environment within the config (`wrangler versions deploy --env <env>`). */
  env?: string;
}

export interface WranglerVersionsPromoteOutput {
  /** The version id that was promoted. */
  versionId: string;
  /** The traffic percentage actually routed to it. */
  percentage: number;
}

/**
 * Promote a Worker version to (some percentage of) live traffic via
 * `wrangler versions deploy <version-id>@<percentage> --yes` — both the
 * gradual-deployment lever (`percentage` < 100) and, at `percentage: 100`,
 * the rollback mechanism: Cloudflare's native version rollback is a promote
 * to a prior version id, not a redeploy, so this same verb composes as the
 * explicit compensation step a component wires up (#1293's "verification"
 * example: forced failure after `wrangler-deploy` -> `wrangler-versions-promote`
 * back to the prior version, no hand-written compensation needed).
 *
 * Also declares its own `rollback` (native, no `rollbackPolicy` override
 * needed — see ../capability.ts): re-promotes to whichever version was live
 * before *this* promote call, for the case where the promote step itself is
 * composed directly (not just as `wrangler-deploy`'s compensation).
 */
export function createWranglerVersionsPromoteCapability(
  processRunner: ProcessRunner = defaultProcessRunner(),
): Capability<WranglerVersionsPromoteInput, WranglerVersionsPromoteOutput> {
  const previousVersionByTarget = new Map<string, string | undefined>();

  return {
    kind: "wrangler-versions-promote",
    async run(_ctx, input) {
      await requireTool(processRunner, WRANGLER_TOOL, `promote version ${input.versionId} in ${input.config}`);
      const percentage = input.percentage ?? 100;
      const target = targetKey(input.config, input.env);
      if (!previousVersionByTarget.has(target)) {
        previousVersionByTarget.set(target, await currentLiveVersionId(processRunner, input.config, input.env));
      }

      await processRunner.run(buildVersionsPromoteArgs(input.config, input.versionId, percentage, input.env));
      return { versionId: input.versionId, percentage };
    },
    async rollback(_ctx, input) {
      const target = targetKey(input.config, input.env);
      const previousVersionId = previousVersionByTarget.get(target);
      if (!previousVersionId) return; // nothing was live before this promote.
      await requireTool(processRunner, WRANGLER_TOOL, `roll back version promotion in ${input.config}`);
      await processRunner.run(buildVersionsPromoteArgs(input.config, previousVersionId, 100, input.env));
    },
  };
}

/** Default `wrangler-versions-promote` capability, backed by the real `ProcessRunner`. */
export const wranglerVersionsPromoteCapability: Capability<
  WranglerVersionsPromoteInput,
  WranglerVersionsPromoteOutput
> = createWranglerVersionsPromoteCapability();
