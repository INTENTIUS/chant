/**
 * The factory reference Op (#3406, ws-087): the factory's rules declared in
 * core, and an orchestrator's execution plugged in through hooks.
 *
 * ```ts
 * // ops/factory.op.ts
 * export default factoryOp({
 *   builder: "node box/ops/factory/builder.mjs",
 * });
 * ```
 *
 * One run is one build of one work item, under that item's lease, in a
 * worktree on `chant/work/<item>`:
 *
 *   Pick        factoryPick: the buildable items, in order; the lease claims the first nobody holds
 *   Ask         factoryAsk: the tier (the item's own, or the slice-tier point) and, for an ask, the
 *               understand point; an open question stops the run waiting
 *   Build       factoryBuild: the `builder` hook, unless understand said not to build
 *   Check       factoryCheck: the `check` hook, or the box's `factory.check`, with its evidence
 *   Record      factoryRecord: done, dropped, redraft, ask or not_done, which the lease's release
 *               takes; a not_done attempt is kept at refs/chant/kept/<item>/<token> by the run
 *
 * The hooks are commands, run with no shell in the worktree:
 *
 * - `builder` (required): how a builder runs, such as Claude Code in the box
 *   or a `fountainRun` wrapper. It gets FACTORY_ITEM, FACTORY_TIER,
 *   FACTORY_TOKEN, FACTORY_HOLDER, FACTORY_WORKTREE and FACTORY_CONTEXT, edits
 *   the worktree, and exits 0 when it finished. It may print a last JSON line
 *   `{ "reverted": [paths] }` when its guard put changes back.
 * - `context` (optional): passed to the builder as FACTORY_CONTEXT, the prompt
 *   and context bundle the orchestrator assembles.
 * - `check` (optional): the verdict command; the box block's `factory.check`
 *   when left out. An infra profile names a plan or `chant lint` here.
 *
 * Publishing a done item is the box's publisher (ws-088), run later by a
 * person or a surface with `chant workspace box publish`; it is not a step.
 */

import { Op, phase, activity } from "./builders";
import { stepOutput } from "./step-output-ref";
import { workLeaseOutput } from "./work-lease-run";
import type { OpConfig } from "./types";

export interface FactoryOpOptions {
  /** The Op's name. `factory` by default. */
  name?: string;
  /** The builder hook: a command run in the run's worktree. */
  builder: string;
  /** The context hook: what the builder receives as FACTORY_CONTEXT. */
  context?: string;
  /** The check hook; the box's `factory.check` when left out. */
  check?: string;
  /** The work kind file, when the declaration names several. */
  kind?: string;
  /** How long a lease is held without a renewal, such as 15m. The lease's default otherwise. */
  ttl?: string;
  /** How long the builder may run. 2h by default. */
  buildTimeout?: string;
  schedule?: OpConfig["schedule"];
  /** Where the workspace is read; the run's working directory when left out. */
  cwd?: string;
  /** Backends for the points' model deciders, in place of `decide.backends` in chant.config. */
  backends?: Record<string, { url: string; key?: unknown; timeoutMs?: number }>;
}

/** The Op's configuration, for a steward that lists it or a test that runs it. */
export function factoryOpConfig(options: FactoryOpOptions): OpConfig {
  if (!options || typeof options.builder !== "string" || options.builder.trim() === "") {
    throw new Error("factoryOp needs a builder: the command that runs a builder in the run's worktree");
  }
  const lease = workLeaseOutput();
  const kind = options.kind !== undefined ? { kind: options.kind } : {};
  const at = options.cwd !== undefined ? { cwd: options.cwd } : {};
  return {
    name: options.name ?? "factory",
    overview: "Build the next buildable work item under its lease: pick, ask, build, check and record, by the factory's rules (#3406, ws-087)",
    workLease: {
      item: stepOutput("pick", "candidates"),
      outcome: stepOutput("record", "outcome"),
      ...kind,
      ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
    },
    changesCheckout: true,
    ...(options.schedule ? { schedule: options.schedule } : {}),
    phases: [
      phase("Pick", [activity("factoryPick", { ...kind, ...at }, { profile: "fastIdempotent", id: "pick" })]),
      phase("Ask", [activity("factoryAsk", { lease, ...kind, ...at, ...(options.backends ? { backends: options.backends } : {}) }, { profile: "fastIdempotent", id: "ask" })]),
      phase("Build", [
        activity(
          "factoryBuild",
          { lease, ...at, ask: stepOutput("ask"), builder: options.builder, ...(options.context !== undefined ? { context: options.context } : {}) },
          { profile: "atMostOnce", id: "build", timeout: options.buildTimeout ?? "2h" },
        ),
      ]),
      phase("Check", [activity("factoryCheck", { lease, ...at, build: stepOutput("build"), ...(options.check !== undefined ? { check: options.check } : {}) }, { profile: "atMostOnce", id: "check" })]),
      phase("Record", [activity("factoryRecord", { lease, ...at, ask: stepOutput("ask"), build: stepOutput("build"), check: stepOutput("check") }, { profile: "atMostOnce", id: "record" })]),
    ],
  } as OpConfig;
}

/** The factory reference Op, as an `*.op.ts` file exports it. */
export function factoryOp(options: FactoryOpOptions): ReturnType<typeof Op> {
  return Op(factoryOpConfig(options));
}
