/**
 * The `predictBehaviour` activity and the pull-request finding built on it
 * (#2358, epic #2355).
 *
 * Two activities, because they answer two questions:
 *
 *  - {@link predictBehaviour} asks the project's predicting lexicon what the
 *    declared estate would do at a stated traffic level, and returns the
 *    {@link BehaviourResult} as the contract defines it — a report, or a named
 *    refusal. It builds the project in-process, assembles the request from the
 *    build the way `lifecycle plan` assembles a deep read's, and hands it to
 *    the one configured lexicon that implements the fourth observation method.
 *    `isBehaviourRefusalReport` is the branch every consumer of its result
 *    takes first.
 *  - {@link behaviourFinding} runs that prediction twice — once on the
 *    checkout the run is in (the pull request's head) and once on the base
 *    branch it targets — differences the two under the rules in
 *    `../../behaviour-delta.ts`, and posts the finding in `comment` mode
 *    through {@link reconcilePr}. Same sticky comment on GitHub and Forgejo,
 *    same merge-request note on GitLab, same marker recipe: nothing here
 *    posts anything itself.
 *
 * ## The base side is a checkout, not a snapshot
 *
 * The finding is declared-versus-declared: the graph the pull request
 * proposes against the graph its base branch already holds. Both sides are
 * built from source, so the base branch is checked out into a detached git
 * worktree under the repository's own root (module resolution walks up from
 * there to the same `node_modules` the head build uses) and removed again
 * whether the prediction succeeded or not. A shallow CI clone does not carry
 * the base branch, so it is fetched at depth one first — the same reason
 * `converge.ts` fetches `chant/lifecycle` before reading it.
 *
 * The base branch name comes off the run's own event, the way the pull
 * request itself does in `reconcile.ts`: `GITHUB_BASE_REF` on a GitHub
 * Actions or Forgejo Actions `pull_request` job, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`
 * on a GitLab `merge_request_event` pipeline. A run with neither and no
 * explicit `base` fails by name rather than guessing `main`.
 *
 * ## What the marker names
 *
 * The comment's hidden marker names the Op and the env together
 * ({@link behaviourFindingMarker}), for #2319's reason: a `comment`-mode
 * `reconcilePr` step on the same pull request keys its marker on the env
 * alone, and a behaviour finding over `prod` sharing a marker with a plan
 * finding over `prod` would edit the wrong comment on every push.
 *
 * ## Edge coverage on the declared path
 *
 * `buildGraphIr` produces reference edges and is exhaustive for them. It
 * produces no containment — a subnet's membership of a VPC is not a reference
 * — and #2360's third comment records that nothing on the declared path does
 * yet. So the request never claims `complete`: that would be a true claim
 * about references and a false one about the graph. It cannot honestly claim
 * `partial` either, because `partial` has to name a gap as `dangling` or
 * `unresolvedKinds`, and the gap here is neither — every reference resolved,
 * and the generic builder has no vocabulary for "this kind is a boundary
 * whose containment is missing" (the request fixture names its boundary
 * kinds by hand, which is lexicon knowledge core does not have). An earlier
 * draft named every kind no reference touched, and named a queue nobody
 * references as "unresolved", which it is not. So the claim is `unknown`,
 * which the contract tells a consumer to treat exactly as it treats
 * `partial`, and the finding shows each side's coverage and does not compare
 * resilience verdicts across it — see `renderBehaviourFinding`.
 */

import { exec } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isBehaviourRefusalReport,
  type BehaviourEdgeCoverage,
  type BehaviourResult,
  type PredictBehaviourOptions,
} from "../../behaviour";
import {
  behaviourDelta,
  renderBehaviourFinding,
  validateBehaviourResult,
  type BehaviourDelta,
} from "../../behaviour-delta";
import type { LexiconPlugin } from "../../lexicon";
import type { BehaviourKinds } from "../../behaviour-kinds";
import { createBehaviourPredict } from "../../behaviour-predict";
import type { SerializerResult } from "../../serializer";
import { markerSlug, reconcilePr, suppliedMarker, type ReconcileResult } from "./reconcile";

const execAsync = promisify(exec);

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/* -------------------------------------------------------------------------- */
/* predictBehaviour                                                           */
/* -------------------------------------------------------------------------- */

export interface PredictBehaviourArgs {
  /** The environment the prediction is for, mirroring the deep read's `environment`. */
  environment: string;
  /** The traffic level to predict at, verbatim: `100 rps, p50`. Never parsed here. */
  traffic: string;
  /** Deployed stack, for a multi-stack project. */
  stack?: string;
  /** Region the stack is deployed in. */
  region?: string;
  /** Restrict to chant-owned resources; a withheld entity is `filtered`, not absent. */
  owned?: boolean;
}

/**
 * What the activity says when nothing has contributed coverage rows.
 *
 * Not an error and not a refusal: the prediction runs, every declared entity
 * is withheld as `unknown-type`, and this is what the report's own detail says
 * one level down. Kept as a message rather than a throw because an estate
 * whose lexicons contribute no rows is a real state with a real answer — "no
 * row says what any of these are" — and a throw would turn it into a broken
 * command (#2382).
 */
export function noContributedRowsMessage(lexicons: readonly string[]): string {
  const configured = lexicons.length > 0 ? lexicons.join(", ") : "(none)";
  return (
    "predictBehaviour has the estate to predict and no coverage rows to read it with: none of the " +
    `configured lexicons (${configured}) contributes \`behaviourKinds\`. Every entity will be reported ` +
    "unpredicted as `unknown-type`. Set CHANT_BEHAVIOUR_ENGINE to the engine's address, and add rows " +
    "in the lexicon that owns the entity types you expect priced."
  );
}

/**
 * The declared path's honest coverage claim. See the module doc: reference
 * edges are exhaustive and containment is absent, and the contract has a
 * field for a missing reference and none for missing containment, so the
 * claim is `unknown`. Never `complete`, and not `partial` naming a kind the
 * generic builder has no basis to name. A function rather than a constant so
 * the day the declared path produces containment edges (#2360), the claim
 * changes here and nowhere else.
 */
export function declaredEdgeCoverage(): BehaviourEdgeCoverage {
  return { verdict: "unknown" };
}

/**
 * Predict the estate declared under `projectPath`. The in-process half of
 * {@link predictBehaviour}, taking the project root explicitly so the
 * finding can run it on the base checkout too.
 *
 * Imports are dynamic so this module carries no load-time edge into the CLI
 * or the build: `cli/plugins` reaches back into the root index, and the
 * activity registry imports this module statically.
 */
export async function predictDeclared(projectPath: string, args: PredictBehaviourArgs): Promise<BehaviourResult> {
  const { loadChantConfigUpward } = await import("../../config");
  const { loadPlugins, resolveProjectLexicons } = await import("../../cli/plugins");
  const { build } = await import("../../build");
  const { buildGraphIr } = await import("../../graph-ir");

  const { config } = await loadChantConfigUpward(projectPath);
  const lexicons = await resolveProjectLexicons(projectPath);
  const plugins = (await loadPlugins(lexicons)) as LexiconPlugin[];
  // Rows, not a predictor. Since #2382 core predicts and each lexicon says
  // only what its own entity types mean, so there is nothing to choose between
  // and nothing to refuse when two lexicons both answer — they are additive.
  const kinds = plugins.map((p) => p.behaviourKinds).filter((k): k is BehaviourKinds => k !== undefined);

  const sourceDir = resolve(projectPath, config.sourceDir ?? ".");
  const result = await build(sourceDir, plugins.map((p) => p.serializer));
  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => (typeof e === "string" ? e : (e as { message?: string }).message ?? String(e)));
    throw new Error(`predictBehaviour: the project under ${projectPath} did not build: ${messages.join("; ")}`);
  }

  // Every declared entity with a type. The contributed rows decide what
  // reaches the engine and what is declared unmapped, and they can only decide
  // about what they are handed: filtering here to "resources" would silently
  // drop the kinds the coverage rows exist to name.
  const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [name, entity] of result.entities) {
    const declarable = entity as { entityType?: unknown; props?: unknown };
    if (typeof declarable.entityType !== "string") continue;
    entities.set(name, {
      entityType: declarable.entityType,
      props: (declarable.props != null ? declarable.props : {}) as Record<string, unknown>,
    });
  }
  const edges = buildGraphIr(result.entities, sourceDir).edges;

  // The build output the other three reads are handed — a string, not a path
  // (cli/handlers/lifecycle.ts). Nothing on this path reads it; the mirror is
  // kept so the four methods take the same shape. With no predicting lexicon
  // to take it from, it is the first output the build produced, or empty.
  const raw = [...result.outputs.values()][0];
  const buildOutput = raw === undefined ? "" : typeof raw === "string" ? raw : (raw as SerializerResult).primary;

  const options: PredictBehaviourOptions = {
    environment: args.environment,
    buildOutput,
    entityNames: [...entities.keys()],
    entities,
    ...(args.stack ? { stack: args.stack } : {}),
    ...(args.region ? { region: args.region } : {}),
    ...(args.owned !== undefined ? { owned: args.owned } : {}),
    traffic: args.traffic,
    edges,
    edgeCoverage: declaredEdgeCoverage(),
  };
  const answer = await createBehaviourPredict({ kinds })(options);
  // On arrival, with the names that were asked — `behaviourReport` checks the
  // ordinary route and says a consumer that needs the guarantee checks again.
  return validateBehaviourResult(answer, options.entityNames);
}

/**
 * Predict the declared estate in the working directory at `args.traffic`.
 * Returns the contract's result as it is; a refusal is a result, not a
 * thrown error, and `isBehaviourRefusalReport` is the branch to take first.
 * Uses the `fastIdempotent` profile: the build is offline and the engine call
 * is read-only.
 */
export async function predictBehaviour(args: PredictBehaviourArgs): Promise<BehaviourResult> {
  return predictDeclared(resolve("."), args);
}

/* -------------------------------------------------------------------------- */
/* behaviourFinding                                                           */
/* -------------------------------------------------------------------------- */

/** How the finding leaves the run. Only the two modes a pull request can carry. */
export type BehaviourFindingMode = "comment" | "report";

export interface BehaviourFindingArgs extends PredictBehaviourArgs {
  /**
   * The name of the Op this step belongs to — it keys the sticky comment's
   * marker together with `environment` ({@link behaviourFindingMarker}), so
   * two Ops over one env own two comments. Required for the same reason
   * `reconcilePr`'s `issue` mode requires it (#2319).
   */
  op: string;
  /** `comment` posts on the triggering pull or merge request; `report` returns the body only. Default: `comment`. */
  mode?: BehaviourFindingMode;
  /**
   * The base branch to predict the other side from. Read off the run's own
   * event when omitted — `GITHUB_BASE_REF`, then `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`
   * — and refused by name when neither is set.
   */
  base?: string;
  /** Comment title, unused on a sticky comment but carried for `reconcilePr`'s result. */
  title?: string;
}

export interface BehaviourFindingResult {
  mode: BehaviourFindingMode;
  /** The base branch the other side was predicted from. */
  base: string;
  /** What the head side was called in the finding. */
  head: string;
  /** The structured delta, before rendering. */
  finding: BehaviourDelta;
  /** True when either side refused, so the finding says "no prediction". */
  refused: boolean;
  /** The rendered Markdown, whether or not it was posted. */
  summary: string;
  /** The posted or updated comment / note URL (comment mode). */
  commentUrl?: string;
  /** `owner/repo#number` (comment mode, GitHub and Forgejo). */
  pullRequest?: string;
  /** `group/project!iid` (comment mode, GitLab). */
  mergeRequest?: string;
}

/**
 * The hidden marker a behaviour finding is found by across re-runs. Keyed on
 * the Op *and* the env, both slugified the same way `reconcilePr`'s markers
 * are, and distinct from both of those by its prefix: a `comment`-mode
 * `reconcilePr` step and this step on one pull request must never match each
 * other's comment.
 */
export function behaviourFindingMarker(op: string, env: string): string {
  return `<!-- chant-behaviour:${markerSlug(op)}/${markerSlug(env)} -->`;
}

/** What the finding says when the run names no base branch to predict against. */
export function noBaseRefMessage(): string {
  return (
    "behaviourFinding predicts the pull request's declared estate against its base branch's, and this run " +
    "names no base branch. On GitHub Actions and Forgejo Actions a pull_request event sets GITHUB_BASE_REF; on " +
    "GitLab CI a merge_request_event pipeline sets CI_MERGE_REQUEST_TARGET_BRANCH_NAME. Trigger the Op from " +
    "one of those, or pass `base` with the branch name."
  );
}

/** Where the base branch name comes from, most specific first. Pure — exported for testing. */
export function baseRefFrom(
  env: Record<string, string | undefined>,
  explicit?: string,
): string | undefined {
  const fromArgs = explicit?.trim();
  if (fromArgs) return fromArgs;
  for (const source of ["GITHUB_BASE_REF", "CI_MERGE_REQUEST_TARGET_BRANCH_NAME"]) {
    const value = env[source]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** What the head side is called in the finding: the source branch when the run names one, else the short commit. */
export function headRefFrom(env: Record<string, string | undefined>, shortSha?: string): string {
  for (const source of ["GITHUB_HEAD_REF", "CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"]) {
    const value = env[source]?.trim();
    if (value) return value;
  }
  return shortSha?.trim() || "head";
}

/** A checked-out base branch: where its project root is, and how to remove it. */
export interface BaseCheckout {
  /** The base branch's counterpart of the working directory. */
  projectPath: string;
  cleanup(): Promise<void>;
}

/**
 * Check `base` out into a detached worktree beside the repository. Fetches it
 * at depth one first, because a CI clone carries only the pull request's own
 * ref; a branch already present locally (a full clone, a developer's own
 * checkout) is used as it stands after the fetch fails.
 */
export async function checkoutBase(base: string, signal?: AbortSignal): Promise<BaseCheckout> {
  const { stdout: rootOut } = await execAsync("git rev-parse --show-toplevel", { signal });
  const { stdout: prefixOut } = await execAsync("git rev-parse --show-prefix", { signal });
  const root = rootOut.trim();
  const prefix = prefixOut.trim();

  let commitish = "FETCH_HEAD";
  try {
    await execAsync(`git fetch --depth=1 origin ${shellQuote(base)}`, { signal });
  } catch {
    // No remote, or no such branch there: a local branch of that name is
    // the only other thing `base` can honestly mean.
    commitish = base;
  }

  const dir = await mkdtemp(join(root, ".chant-behaviour-base-"));
  try {
    await execAsync(`git worktree add --detach ${shellQuote(dir)} ${shellQuote(commitish)}`, { signal });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      `behaviourFinding could not check out base branch ${JSON.stringify(base)}: ${(err as Error).message}`,
    );
  }
  return {
    projectPath: prefix ? join(dir, prefix) : dir,
    async cleanup() {
      try {
        await execAsync(`git worktree remove --force ${shellQuote(dir)}`);
      } catch {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** What {@link createBehaviourFinding} takes instead of reaching for the process. */
export interface BehaviourFindingDeps {
  /** Predict one project root. Default: {@link predictDeclared}. */
  predict?: (projectPath: string, args: PredictBehaviourArgs) => Promise<BehaviourResult>;
  /** Check the base branch out. Default: {@link checkoutBase}. */
  checkout?: (base: string, signal?: AbortSignal) => Promise<BaseCheckout>;
  /** Post the finding. Default: {@link reconcilePr}, whose `comment` mode does the forge split. */
  post?: typeof reconcilePr;
  /** The environment the base and head refs are read from. Default: the process's. */
  env?: Record<string, string | undefined>;
  /** The short commit the head side is named by when the run names no branch. Default: `git rev-parse --short HEAD`. */
  shortSha?: () => Promise<string | undefined>;
}

async function defaultShortSha(): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync("git rev-parse --short HEAD");
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Build the finding activity, with its four side effects injected so a test
 * can drive the whole thing — predict twice, difference, render, post —
 * against fixtures and a stubbed poster.
 */
export function createBehaviourFinding(
  deps: BehaviourFindingDeps = {},
): (args: BehaviourFindingArgs, signal?: AbortSignal) => Promise<BehaviourFindingResult> {
  const predict = deps.predict ?? predictDeclared;
  const checkout = deps.checkout ?? checkoutBase;
  const post = deps.post ?? reconcilePr;
  const env = deps.env ?? process.env;
  const shortSha = deps.shortSha ?? defaultShortSha;

  return async function behaviourFinding(args, signal) {
    const mode: BehaviourFindingMode = args.mode ?? "comment";
    if (typeof args.op !== "string" || args.op.trim() === "") {
      throw new Error(
        "behaviourFinding needs `op`, the name of the Op this step belongs to: it keys the comment's marker " +
          "together with `environment`, and an env alone is not unique across Ops (#2319).",
      );
    }
    const base = baseRefFrom(env, args.base);
    if (!base) throw new Error(noBaseRefMessage());
    const head = headRefFrom(env, await shortSha());
    const predictArgs: PredictBehaviourArgs = {
      environment: args.environment,
      traffic: args.traffic,
      ...(args.stack ? { stack: args.stack } : {}),
      ...(args.region ? { region: args.region } : {}),
      ...(args.owned !== undefined ? { owned: args.owned } : {}),
    };

    // Head first: it is the checkout the run is already in, and a build error
    // there is the pull request's own and should surface before any worktree
    // is created.
    const headResult = await predict(resolve("."), predictArgs);
    const baseCheckout = await checkout(base, signal);
    let baseResult: BehaviourResult;
    try {
      baseResult = await predict(baseCheckout.projectPath, predictArgs);
    } finally {
      await baseCheckout.cleanup();
    }

    const finding = behaviourDelta(
      { label: "base", ref: base, result: baseResult },
      { label: "head", ref: head, result: headResult },
    );
    const summary = renderBehaviourFinding(finding, { env: args.environment, op: args.op });
    const refused = isBehaviourRefusalReport(baseResult) || isBehaviourRefusalReport(headResult);
    const result: BehaviourFindingResult = { mode, base, head, finding, refused, summary };
    if (mode === "report") return result;

    const posted: ReconcileResult = await post(
      {
        env: args.environment,
        op: args.op,
        mode: "comment",
        marker: suppliedMarker(behaviourFindingMarker(args.op, args.environment)),
        body: summary,
        title: args.title ?? `Predicted behaviour for ${args.environment} at ${args.traffic}`,
      },
      signal,
    );
    return {
      ...result,
      ...(posted.commentUrl ? { commentUrl: posted.commentUrl } : {}),
      ...(posted.pullRequest ? { pullRequest: posted.pullRequest } : {}),
      ...(posted.mergeRequest ? { mergeRequest: posted.mergeRequest } : {}),
    };
  };
}

/**
 * Predict the pull request's declared estate and its base branch's, and post
 * the delta as one sticky comment on the pull request — or one note on the
 * merge request — that triggered the run. Needs a pull-request-triggered
 * run; fails by name without one, the same way `reconcilePr`'s `comment`
 * mode does, because that is the function that posts.
 */
export const behaviourFinding = createBehaviourFinding();
