/**
 * augur's `predictBehaviour()` — the first implementation of the fourth
 * observation method (#2357, contract #2356).
 *
 * The whole method is four moves, in this order, and the order is the contract:
 *
 *  1. **Screen the request.** `screenBehaviourRequest` and nothing else. It is
 *     the only entry point, and calling `assertNoCredentialInOptions` instead
 *     applies one rule of three — that was review finding F1 on #2365, where a
 *     `ghp_…` past the walk's depth budget and an `awsSecretAccessKey` in
 *     `props` both went out with the request.
 *  2. **Resolve the engine.** `behaviourEngineFrom`, walking
 *     `CHANT_BEHAVIOUR_ENGINE_AUGUR` → `CHANT_BEHAVIOUR_ENGINE` →
 *     `BEHAVIOUR_ENGINE`. Nothing named means `noBehaviourEngineRefusal`, and
 *     it happens **before** anything is priced: a lexicon that prices first and
 *     checks the engine afterwards has already decided what zero means.
 *  3. **Build the request.** `buildEngineRequest`, offline and pure
 *     (`./request.ts`).
 *  4. **Ask, and translate the answer.** One {@link EngineOutcome} onto the
 *     contract's builders. No figure is ever computed here — this file has no
 *     arithmetic on money in it at all, and that is not an accident: the epic's
 *     first rule is that a missing engine produces a refusal and "never a
 *     locally faked number", and the surest way to keep that true is for the
 *     code that would have faked it not to exist.
 *
 * ## Every entity lands somewhere
 *
 * `behaviourReport` refuses a report that leaves a name in neither map, so the
 * loop below has no `continue` that drops one. Four ways an entity can end up
 * unpredicted, and each names a different thing:
 *
 * | Outcome | Reason | Means |
 * |---|---|---|
 * | the coverage table declares it unmapped | `unsupported-kind` | chant looked, and this kind has no rate |
 * | the coverage table has never seen it | `unsupported-kind` | chant has not looked; the detail says so and where to add the row |
 * | the engine declined it | `read-failed` | chant asked and the engine could not answer |
 * | the engine answered about neither | `read-failed` | the engine lost it, and this says so rather than hiding it |
 *
 * The last row is the one that would otherwise be silent. An engine that
 * returns figures for eleven of twelve nodes and mentions the twelfth nowhere
 * is a bug in the engine, and an estate that quietly renders eleven nodes is
 * how it stays a bug.
 */

import {
  behaviourReport,
  behaviourEngineFrom,
  noBehaviourEngineRefusal,
  outOfCreditBehaviourEngineRefusal,
  overQuotaBehaviourEngineRefusal,
  predictedRate,
  screenBehaviourRequest,
  unreachableBehaviourEngineRefusal,
  type BehaviourResult,
  type PredictBehaviourOptions,
  type PredictedBehaviour,
  type UnpredictedEntity,
} from "@intentius/chant/behaviour";
import { buildEngineRequest } from "./request";
import { defaultConnect, type EngineConnect, type EngineFigure } from "./engine";

/** The name this lexicon refuses under, and the one that scopes its variable. */
export const AUGUR = "augur";

/** What {@link createAugurPredict} needs that the method's own options do not carry. */
export interface AugurPredictDeps {
  /** The environment the engine address is resolved from. Defaults to the process's. */
  env?: Record<string, string | undefined>;
  /** How an address becomes a transport. Defaults to `./engine.ts`'s chooser. */
  connect?: EngineConnect;
}

/**
 * Build the lexicon's `predictBehaviour`, with the environment and the
 * transport injected.
 *
 * Injected rather than read from module scope so a test can drive the whole
 * method — screen, resolve, serialize, translate — against a fixture engine
 * without touching `process.env`, which is what the shared conformance suite's
 * probes need in order to ask the same request twice and compare.
 */
export function createAugurPredict(
  deps: AugurPredictDeps = {},
): (options: PredictBehaviourOptions) => Promise<BehaviourResult> {
  const env = deps.env ?? process.env;
  const connect = deps.connect ?? defaultConnect;

  return async function predictBehaviour(options: PredictBehaviourOptions): Promise<BehaviourResult> {
    const unsafe = screenBehaviourRequest(AUGUR, options);
    if (unsafe) return unsafe;

    const endpoint = behaviourEngineFrom(AUGUR, env);
    if (!endpoint) return noBehaviourEngineRefusal(AUGUR);

    const engine = connect(endpoint);
    if (!engine) {
      return unreachableBehaviourEngineRefusal(
        AUGUR,
        endpoint,
        "no transport in this lexicon speaks that address — a command on PATH is dialled here, and a " +
          "URL is the first engine adapter's (chant #2359)",
      );
    }

    const request = buildEngineRequest(options);
    const outcome = await engine.predict(request);

    if (!outcome.ok) {
      const { cause, detail } = outcome.failure;
      if (cause === "engine-out-of-credit") {
        return outOfCreditBehaviourEngineRefusal(AUGUR, endpoint, detail);
      }
      if (cause === "engine-over-quota") {
        return overQuotaBehaviourEngineRefusal(AUGUR, endpoint, detail);
      }
      return unreachableBehaviourEngineRefusal(AUGUR, endpoint, detail);
    }

    const { answer } = outcome;
    // `Object.create(null)`, not `{}`. An entity named `constructor` or
    // `toString` writes onto `Object.prototype`'s members on a plain literal,
    // and one named `__proto__` sets the prototype instead of adding a key, so
    // the entry vanishes and `behaviourReport`'s totality check fires on an
    // entity this function believed it had reported. `coverageFor` already
    // guards its own lookups this way (`./mapping.ts`); these are the same
    // hazard on the writing side.
    const entities: Record<string, PredictedBehaviour> = Object.create(null) as Record<string, PredictedBehaviour>;
    const unpredicted: Record<string, UnpredictedEntity> = Object.create(null) as Record<string, UnpredictedEntity>;

    for (const held of request.withheld) {
      unpredicted[held.name] = {
        ...(held.entityType === "(undeclared)" ? {} : { type: held.entityType }),
        reason: "unsupported-kind",
        detail: held.detail,
      };
    }

    for (const node of request.nodes) {
      // `hasOwnProperty` for the same reason: `answer.declined` comes from
      // `JSON.parse`, so `declined["constructor"]` is a function rather than
      // `undefined` and the `!== undefined` guard below missed it.
      const declined = has(answer.declined, node.name) ? answer.declined![node.name] : undefined;
      if (declined !== undefined) {
        unpredicted[node.name] = {
          type: node.entityType,
          reason: "read-failed",
          detail: `${answer.engine} was sent ${node.name} as a ${node.kind} and declined it: ${declined}`,
        };
        continue;
      }
      const figure = has(answer.figures, node.name) ? answer.figures[node.name] : undefined;
      if (figure === undefined) {
        unpredicted[node.name] = {
          type: node.entityType,
          reason: "read-failed",
          detail:
            `${answer.engine} was sent ${node.name} and its answer names it in neither its figures nor ` +
            "its declined list. An engine that loses a node is reported, not rendered as an estate one " +
            "node smaller.",
        };
        continue;
      }
      entities[node.name] = block(options.traffic, figure, answer);
    }

    return behaviourReport(
      options,
      {
        engine: answer.engine,
        version: answer.version,
        ...(answer.total
          ? { total: predictedRate(answer.total.perHour, answer.total.currency) }
          : {}),
      },
      entities,
      unpredicted,
    );
  };
}

/** An own key, not a prototype member. See the accumulators above. */
function has(map: Record<string, unknown> | undefined, key: string): boolean {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * One engine figure as a contract block.
 *
 * `at` comes from the request rather than from the engine's answer. The engine
 * was asked at one level and `behaviourReport` refuses a block priced at a
 * level the run did not ask for, so echoing the engine's own idea of the level
 * would turn an engine that quietly substituted a level it liked better into a
 * report that agrees with itself and answers the wrong question.
 *
 * `headroom` is copied axis by axis. An axis the engine did not model is
 * **absent**, never `0` — zero headroom means saturated, which is the opposite
 * claim, and `BehaviourHeadroom` is a union requiring at least one axis so a
 * figure with neither is a type error rather than a block behold drops.
 */
function block(
  traffic: string,
  figure: EngineFigure,
  answer: { engine: string; version: string; tolerance: string; basis: PredictedBehaviour["provenance"]["basis"] },
): PredictedBehaviour {
  const cpu = figure.headroom?.cpu;
  const latency = figure.headroom?.latency;
  // Built axis by axis, and the cast the first version used here was a lie:
  // `EngineFigure.headroom` is optional, so a figure stating none produced
  // `{ latency: undefined }` — an object satisfying `BehaviourHeadroom`
  // structurally and carrying no axis at all, which behold drops. The doc
  // claiming a type error caught this was false. `parseEngineAnswer` now
  // refuses such a figure before it reaches here; this stays correct anyway,
  // because a lexicon should not depend on its own validator having run.
  const headroom =
    cpu !== undefined
      ? { cpu, ...(latency !== undefined ? { latency } : {}) }
      : { latency: latency as number };
  if (cpu === undefined && latency === undefined) {
    throw new Error(
      `predictBehaviour: the engine's figure for this entity carries neither a cpu nor a latency ` +
        "headroom axis, and parseEngineAnswer should have refused it.",
    );
  }
  return {
    at: { traffic },
    cost: predictedRate(figure.perHour, figure.currency),
    headroom,
    errorRate: figure.errorRate,
    resilience: {
      failure: figure.resilience.failure,
      verdict: figure.resilience.verdict,
      ...(figure.resilience.note ? { note: figure.resilience.note } : {}),
    },
    ...(figure.rightSize ? { rightSize: figure.rightSize } : {}),
    provenance: {
      engine: answer.engine,
      version: answer.version,
      tolerance: answer.tolerance,
      basis: answer.basis,
    },
  };
}
