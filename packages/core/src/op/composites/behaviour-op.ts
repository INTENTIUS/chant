/**
 * BehaviourOp composite — the predicted delta of a pull request as a review
 * finding (#2358, epic #2355).
 *
 * One phase, one step: `behaviourFinding` predicts the declared estate on the
 * pull request's head and on its base branch, differences the two under the
 * contract's rules, and posts the finding in `comment` mode on the pull
 * request (GitHub, Forgejo) or as a note on the merge request (GitLab) that
 * triggered the run. There is no `schedule` here and there never will be: the
 * cadence is the pull request, and the trigger lives on the `ScheduledOpSpec`
 * handed to `generateOpsPipeline` (`{ kind: "pull_request" }`), the way
 * `TerraformWatchOp`'s does.
 *
 * `findingMode: "report"` returns the body without posting, for a `chant run`
 * on a developer's machine with `base` named by hand.
 *
 * @example
 * ```typescript
 * export const { op } = BehaviourOp({
 *   name: "pr-behaviour",
 *   env: "prod",
 *   traffic: "1000 rps, p99",
 * });
 * ```
 */

import { Op, phase } from "../builders";
import type { OpResource } from "../resource";
import type { BehaviourFindingArgs, BehaviourFindingMode } from "../activities/predict-behaviour";

export interface BehaviourOpConfig {
  /** Op name (kebab-case). Names the Op's output directory, is what `chant run` takes, and keys the comment's marker. */
  name: string;
  /** Environment the prediction is for. */
  env: string;
  /** The traffic level to predict at, verbatim: `1000 rps, p99`. */
  traffic: string;
  /**
   * What to do with the finding. `comment` posts it on the triggering pull or
   * merge request; `report` returns the body only.
   * @default "comment"
   */
  findingMode?: BehaviourFindingMode;
  /** The base branch, when the run cannot read it off its own event (a local `chant run`). */
  base?: string;
  /** Deployed stack, for a multi-stack project. */
  stack?: string;
  /** Region the stack is deployed in. */
  region?: string;
  /** Restrict to chant-owned resources. */
  scope?: { owned?: boolean };
}

export interface BehaviourOpResources {
  /** Op resource — the predict-both-sides-and-post Op. */
  op: InstanceType<typeof OpResource>;
}

export function BehaviourOp(config: BehaviourOpConfig): BehaviourOpResources {
  const mode = config.findingMode ?? "comment";
  const args: BehaviourFindingArgs = {
    environment: config.env,
    traffic: config.traffic,
    // `op` names this Op in the marker the sticky comment is found by (#2319).
    op: config.name,
    mode,
    ...(config.base ? { base: config.base } : {}),
    ...(config.stack ? { stack: config.stack } : {}),
    ...(config.region ? { region: config.region } : {}),
    ...(config.scope?.owned !== undefined ? { owned: config.scope.owned } : {}),
  };

  const op = Op({
    name: config.name,
    overview: `Predict the ${config.env} estate's behaviour at "${config.traffic}" against the base branch`,
    labels: {
      Behaviour: "true",
      Env: config.env,
    },
    phases: [
      phase("Predict", [
        {
          kind: "activity" as const,
          fn: "behaviourFinding",
          args: { ...args },
          // The finding's headline is the posted comment, and whether either
          // side refused: a refusal is a finding that says "no prediction",
          // and a reader of the run ledger should see that without opening it.
          outcomeAttribute: [
            { name: "Refused", from: "refused" },
            ...(mode === "comment" ? [{ name: "Comment", from: "commentUrl" }] : []),
          ],
        },
      ]),
    ],
  });

  return { op };
}
