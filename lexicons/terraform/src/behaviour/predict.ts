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
import { createBehaviourPredict } from "@intentius/chant/behaviour-predict";
import type { EntityReference } from "@intentius/chant/graph-ir";
import { indexLivePlan, readLiveLs, type TerraformReadDeps } from "../describe-resources";
import type { TerraformConfig } from "../config";
import { RESOURCE_TYPE } from "../hcl/parse";
import { choudoufuLiveLs, choudoufuLivePlan } from "../op/activities/terraform";
import { terraformBehaviourKinds } from "./kinds";
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
   * Which estate to predict, as the contract's own `from` (#2494) and required
   * for the same reason: a default is a guess about which estate somebody
   * meant, and the report that comes back from a wrong guess is well-formed.
   *
   * `"live"` is this path's whole point: the account as it stands, drift
   * included. `"declared"` runs the same producer over the declaration alone
   * and reads no account, which is the other half of the delta the epic asks
   * for (#2355) — a caller wanting that delta calls this twice and differences
   * the two reports, and gets two reports assembled by one producer rather
   * than two shapes that have each been through a different translation.
   *
   * `"declared"` on a project with no live root is the same request `"live"`
   * builds, because there is no account to read; the option exists so that a
   * caller can ask for the declaration of a root that *is* live.
   */
  from: "live" | "declared";
}

/**
 * What the plugin method runs with, where a caller injects nothing (#2495).
 *
 * The two reads are the activities `describeResources` already drives. The
 * engine front is core's, handed this lexicon's coverage rows and no other's:
 * a plugin method takes options alone and cannot see which other lexicons the
 * project configured, and every name this producer sends is a terraform block
 * or a name it passed through untouched. A passed-through name of another
 * lexicon's type comes back `unknown-type`, which is true of what this path
 * knows about it.
 */
const REAL_DEPS: TerraformBehaviourDeps = {
  liveLs: choudoufuLiveLs,
  livePlan: choudoufuLivePlan,
  predict: createBehaviourPredict({ kinds: [terraformBehaviourKinds] }),
};

/** Reads the project's declaration afresh. Injectable so a test parses nothing from disk. */
export type TerraformDeclarationReader = (cwd?: string) => Promise<ReadonlyMap<string, TerraformBehaviourEntity>>;

/**
 * The build's own entities, read again from the project's config: what
 * `buildRoots()` renders, with `mode`, `body` and `references` as the parse
 * stamps them. The config is found the way `observeAmbient` and the
 * activities find it, so `terraform.roots` means one thing to all of them.
 */
export const readTerraformDeclaration: TerraformDeclarationReader = async (cwd) => {
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  const { renderTerraformRoots } = await import("../hcl/roots");
  const { dirname, resolve } = await import("node:path");

  const start = resolve(cwd ?? process.cwd());
  const { config, configPath } = await loadChantConfigUpward(start);
  const namespace = (config as { terraform?: TerraformConfig }).terraform;
  const entities = new Map<string, TerraformBehaviourEntity>();
  if (!namespace?.roots || Object.keys(namespace.roots).length === 0) return entities;
  const rendered = await renderTerraformRoots({
    projectRoot: configPath ? dirname(configPath) : start,
    roots: namespace.roots,
    binary: namespace.binary,
    callModuleType: namespace.callModuleType,
  });
  for (const [name, entity] of rendered.entities) {
    const e = entity as unknown as TerraformBehaviourEntity;
    entities.set(name, {
      entityType: e.entityType,
      props: e.props ?? {},
      ...(Array.isArray(e.references) ? { references: e.references } : {}),
    });
  }
  return entities;
};

const rootOf = (entity: TerraformBehaviourEntity | undefined): string | undefined =>
  typeof entity?.props.root === "string" ? entity.props.root : undefined;

/**
 * Read the contract's options as this producer's (#2495): the plugin method's
 * whole adaptation. Two things are missing from an entity by the time a graph
 * has carried it here, and which one depends on the graph.
 *
 * ## A declared graph has lost its `references`
 *
 * `root` and `mode` need no work: they are on `props`, the graph projects
 * `props` onto a node's `attrs` as they stand, and `behaviourRequestFromIr`
 * hands `attrs` back as `props`. `references` are left off `attrs` on
 * purpose, because an edge already says the same thing (`graph-ir.ts`'s
 * `SKIP_KEYS`), and the contract's `edges` arrive in their place. An `IREdge`
 * is an `EntityReference` plus the entity it leaves from, so grouping the
 * edges by `from` gives every entity its references back, field for field.
 * Without this a block whose body holds a `${…}` is counted as an unresolved
 * kind on a graph that resolved it. An entity that still carries its own
 * `references` keeps them: the edges are the copy.
 *
 * ## A live graph has lost the declaration
 *
 * `chant graph --live` hands over observed nodes: an address, a root, the
 * provider's type, and no `mode`, no `body` and no edge. Read as they stand,
 * no root is live, so the account is never read here; no block has a size,
 * because `body.instance_type` went with the body; and containment is empty.
 * The figures that come back are well-formed and differ from the declared
 * side's for reasons that have nothing to do with the account, which is the
 * delta this producer exists to keep honest.
 *
 * So under `from: "live"`, a root any of whose entities arrived with no
 * `mode` is declared again from the project's own config, and the producer
 * then reads the account itself, as it does for any other caller. The
 * observed entities of that root are set aside, the undeclared ones
 * included: an owned orphan is the live read's to list, under the key
 * `observeAmbient` gave it, and one the account no longer holds is not in a
 * prediction of the account.
 *
 * A root the config does not render is left as it arrived. That is a worse
 * reading and the only one available.
 *
 * ## What stops here
 *
 * The caller's `edges` and `edgeCoverage`. Both are this producer's to
 * compute, from whichever reads it ends up making (see
 * {@link TerraformPredictOptions}).
 */
export async function terraformPredictOptionsFrom(
  options: PredictBehaviourOptions,
  redeclare: TerraformDeclarationReader = readTerraformDeclaration,
): Promise<TerraformPredictOptions> {
  const { entities: given, edges, edgeCoverage: _edgeCoverage, ...rest } = options;
  const leaving = new Map<string, EntityReference[]>();
  for (const edge of edges ?? []) {
    if (edge.kind !== "ref") continue;
    const reference: EntityReference = {
      to: edge.to,
      ...(edge.viaAttr !== undefined ? { viaAttr: edge.viaAttr } : {}),
      ...(edge.toAttr !== undefined ? { toAttr: edge.toAttr } : {}),
    };
    (leaving.get(edge.from) ?? leaving.set(edge.from, []).get(edge.from)!).push(reference);
  }
  const entities = new Map<string, TerraformBehaviourEntity>();
  for (const [name, entity] of given) {
    const own = (entity as TerraformBehaviourEntity).references;
    const references = Array.isArray(own) ? own : leaving.get(name);
    entities.set(name, references === undefined ? entity : { ...entity, references });
  }
  if (options.from !== "live") return { ...rest, entities };

  const observed = new Set<string>();
  for (const name of options.entityNames) {
    const entity = entities.get(name);
    const root = rootOf(entity);
    if (root !== undefined && entity?.props.mode === undefined) observed.add(root);
  }
  if (observed.size === 0) return { ...rest, entities };

  const declared = new Map<string, Map<string, TerraformBehaviourEntity>>();
  for (const [name, entity] of await redeclare()) {
    const root = rootOf(entity);
    if (root === undefined || !observed.has(root)) continue;
    (declared.get(root) ?? declared.set(root, new Map()).get(root)!).set(name, entity);
  }
  const entityNames = options.entityNames.filter((name) => {
    const root = rootOf(entities.get(name));
    if (root === undefined || !declared.has(root)) return true;
    entities.delete(name);
    return false;
  });
  for (const again of declared.values()) {
    for (const [name, entity] of again) {
      entities.set(name, entity);
      entityNames.push(name);
    }
  }
  return { ...rest, entityNames, entities };
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
  deps: TerraformBehaviourDeps = REAL_DEPS,
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
    from: options.from,
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
