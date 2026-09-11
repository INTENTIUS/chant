/**
 * The live path for choudoufu roots (#2360): a prediction of the account as
 * it stands, drift included.
 *
 * `describeResources` (`../describe-resources.ts`) answers "does this declared
 * block exist" for a live root by running `choudoufu live-plan -json` through
 * the applier's own activity. This does the same two reads — `live-ls -json`
 * for what the account holds, `live-plan -json` for how that binds to the
 * declaration — through the same injected activities, builds the engine's
 * request from them (`./request.ts`), and hands it to whichever lexicon fronts
 * the engine. The terraform lexicon has no engine of its own and dials none:
 * `deps.predict` is core's `predictBehaviour` in production, and a fixture
 * in a test.
 *
 * ## Four moves, in this order
 *
 *  1. **Read.** One `live-ls` and one `live-plan` per live root — none at all
 *     under `from: "declared"` — no ambient
 *     credentials and no new shell-out: the activities are the ones
 *     `describeResources` already runs. A root whose read fails reports every
 *     resource it declares `read-failed`, naming the root, and is not sent — a
 *     failed read must never render as an estate with nothing in it.
 *  2. **Build.** `terraformBehaviourRequest`, pure, over the parsed documents.
 *  3. **Screen.** `screenBehaviourRequest`, before any engine is asked. Live
 *     props are exactly where a resolved connection string or a secret written
 *     into a tag can appear, and the screen's key-name, value-shape,
 *     URL-userinfo and walk-depth rules all apply to them. A refusal here is
 *     the result.
 *  4. **Ask, and account for the rest.** The engine-fronting lexicon answers
 *     for what was sent. What was not sent — a resource the plan could not
 *     read, one withheld by `owned`, every resource of a root whose read
 *     failed — is merged into the report as `unpredicted` with its reason, so
 *     every declared name still lands in one map or the other.
 *
 * A root that is not live is built from its declaration by the same producer,
 * so a project mixing stock and live roots gets one request with both, and
 * `sources` says which is which. With no live root at all this is the
 * declared path, containment included.
 *
 * ## Both halves of the delta come out of here
 *
 * `from: "declared"` reads no account and builds every root from its file,
 * including a root that is live. That is the other side of the delta the epic
 * wants, and it is deliberately the same function rather than a second one:
 * two reports that differ because one producer was handed different input are
 * a statement about the estate, and two reports that differ because two
 * producers disagree about how to assemble a graph are a statement about
 * chant. `edgeCoverage.containmentEdges` is the field that made the
 * difference concrete (#2360's third review comment) — it is built by the same
 * catalog over the same reconstruction on both sides here, so a "one zone
 * lost" verdict that differs between the two differs because the account
 * differs.
 */

import {
  behaviourReport,
  isBehaviourRefusalReport,
  screenBehaviourRequest,
  type BehaviourResult,
  type PredictBehaviourOptions,
  type UnpredictedEntity,
} from "@intentius/chant/behaviour";
import { indexLivePlan, readLiveLs, type TerraformReadDeps } from "../describe-resources";
import { RESOURCE_TYPE } from "../hcl/parse";
import {
  terraformBehaviourRequest,
  type TerraformBehaviourEntity,
  type TerraformLiveRead,
} from "./request";

/** The name this path screens and refuses under. */
export const TERRAFORM = "terraform";

/** What the live path needs beyond the request: the two reads, and an engine to ask. */
export interface TerraformBehaviourDeps {
  liveLs: TerraformReadDeps["liveLs"];
  livePlan: TerraformReadDeps["livePlan"];
  /**
   * The lexicon in front of the engine. Its own `screenBehaviourRequest` runs
   * again inside; that is harmless, and the one here is what makes "screened
   * before any engine call" true of this path rather than of its callee.
   */
  predict: (options: PredictBehaviourOptions) => Promise<BehaviourResult>;
}

/**
 * The contract's options, less the three fields this path produces rather than
 * accepts, plus where to read from.
 *
 * `edges` and `edgeCoverage` are **not** inputs. They are what
 * `./request.ts` computes — from the live reads on one side and from the
 * declaration on the other — and a caller has no way to know either before
 * this function has decided which roots it is reading. Asking for them and
 * then discarding whatever arrived would be a signature that lies about what
 * it uses, and the delta this path exists for depends on both sides' coverage
 * being this producer's claim rather than a caller's.
 *
 * `entities` is widened to carry the terraform build's `references` beside
 * `props`, which the builder needs and the contract's own entity shape has no
 * room for.
 */
export interface TerraformPredictOptions
  extends Omit<PredictBehaviourOptions, "entities" | "edges" | "edgeCoverage"> {
  entities: ReadonlyMap<string, TerraformBehaviourEntity>;
  /** Directory the activities start the `chant.config.*` search from. Default: the process cwd. */
  cwd?: string;
  /**
   * Which estate to predict. `"live"`, the default, is this path's whole
   * point: the account as it stands, drift included. `"declared"` runs the
   * same producer over the declaration alone and reads no account, which is
   * the other half of the delta the epic asks for (#2355) — a caller wanting
   * that delta calls this twice and differences the two reports, and gets two
   * reports assembled by one producer rather than two shapes that have each
   * been through a different translation.
   *
   * `"declared"` on a project with no live root is the same request `"live"`
   * builds, because there is no account to read; the option exists so that a
   * caller can ask for the declaration of a root that *is* live.
   */
  from?: "live" | "declared";
}

/** Which roots the request would read live: those whose entities the parse stamped `mode: "live"`. */
export function liveRootsOf(
  entityNames: readonly string[],
  entities: ReadonlyMap<string, TerraformBehaviourEntity>,
): string[] {
  const roots = new Set<string>();
  for (const name of entityNames) {
    const props = entities.get(name)?.props;
    const root = typeof props?.root === "string" ? props.root : undefined;
    if (root && props?.mode === "live") roots.add(root);
  }
  return [...roots].sort();
}

function readsAsCredentials(text: string): boolean {
  return /\b(no valid credential|credentials?|not authorized|unauthorized|accessdenied|access denied|expiredtoken|invalidclienttokenid|signature)\b/i.test(
    text,
  );
}

/**
 * Predict from the account for every live root, and from the declaration for
 * every other, through the engine `deps.predict` fronts.
 */
export async function predictTerraformBehaviour(
  options: TerraformPredictOptions,
  deps: TerraformBehaviourDeps,
): Promise<BehaviourResult> {
  const { cwd, from: _from, ...contract } = options;
  const where = cwd ? { cwd } : {};

  const reads: TerraformLiveRead[] = [];
  const failed = new Map<string, string>();
  const roots = options.from === "declared" ? [] : liveRootsOf(options.entityNames, options.entities);
  for (const root of roots) {
    try {
      const listed = await deps.liveLs({ root, consistent: true, ...where });
      const planned = await deps.livePlan({ root, ...where });
      reads.push({ root, listing: readLiveLs(listed.json), plan: indexLivePlan(planned.json) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.set(root, message);
    }
  }

  // A root whose read failed contributes no node and every one of its
  // resources as `read-failed`, naming the root: the tri-state's rule for a
  // broken read, applied to a prediction.
  const unpredicted: Record<string, UnpredictedEntity> = {};
  const entityNames = options.entityNames.filter((name) => {
    const entity = options.entities.get(name);
    const root = typeof entity?.props.root === "string" ? entity.props.root : undefined;
    if (!root || !failed.has(root)) return true;
    if (entity?.entityType === RESOURCE_TYPE) {
      const message = failed.get(root)!;
      unpredicted[name] = {
        type: RESOURCE_TYPE,
        reason: "read-failed",
        detail:
          `terraform.roots.${root}: the live read failed, so the account was not predicted for this root` +
          `${readsAsCredentials(message) ? " (the failure names credentials)" : ""}: ${message.split("\n")[0]}`,
      };
      return false;
    }
    return true;
  });

  const built = terraformBehaviourRequest({
    environment: contract.environment,
    buildOutput: contract.buildOutput,
    traffic: contract.traffic,
    ...(contract.region !== undefined ? { region: contract.region } : {}),
    ...(contract.stack !== undefined ? { stack: contract.stack } : {}),
    ...(contract.owned !== undefined ? { owned: contract.owned } : {}),
    entityNames,
    entities: options.entities,
    live: reads,
  });
  Object.assign(unpredicted, built.unpredicted);

  const unsafe = screenBehaviourRequest(TERRAFORM, built.request);
  if (unsafe) return unsafe;

  const result = await deps.predict(built.request);
  if (isBehaviourRefusalReport(result)) return result;

  const extra = Object.keys(unpredicted);
  if (extra.length === 0) return result;
  return behaviourReport(
    {
      entityNames: [...built.request.entityNames, ...extra],
      traffic: result.meta.at.traffic,
      edgeCoverage: result.meta.edgeCoverage,
    },
    {
      engine: result.meta.engine,
      version: result.meta.version,
      ...(result.meta.total ? { total: result.meta.total } : {}),
    },
    result.entities,
    { ...result.unpredicted, ...unpredicted },
  );
}
