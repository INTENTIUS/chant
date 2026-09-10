/**
 * The example project, assembled into a request the way a caller would.
 *
 * Shared by `../request.test.ts` (which holds the result to the committed
 * golden file) and by `../predict-behaviour.test.ts` (which runs the shared
 * conformance suite over it). One place rather than two, because the two
 * suites asserting slightly different estates is how a golden file goes green
 * while the thing it is a golden of has moved.
 *
 * It builds a real project — `lexicons/augur/examples/getting-started` — with
 * the real `build()` and the real `buildGraphIr()`, rather than hand-writing an
 * entity map. A hand-written map agrees with itself; a build finds out whether
 * discovery order, a composite's expansion or a property bag's insertion order
 * reaches the bytes.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "@intentius/chant/build";
import { buildGraphIr } from "@intentius/chant/graph-ir";
import { loadPlugins, resolveProjectLexicons } from "@intentius/chant/cli";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import type { BehaviourEdgeCoverage, PredictBehaviourOptions } from "@intentius/chant/behaviour";

const here = dirname(fileURLToPath(import.meta.url));

/** `lexicons/augur/examples/getting-started`. */
export const EXAMPLE_ROOT = join(here, "..", "..", "examples", "getting-started");

/**
 * The traffic level the golden request is built at — `steady`'s, from the
 * example's own `profiles.ts`. Written out here rather than read out of the
 * build, because a golden file whose every input is derived from the same
 * source it is a golden of goes green after a change to both halves at once.
 */
export const GOLDEN_TRAFFIC = "100 rps, p50";

/** The second level the conformance probes ask at. `peak`'s, from the same file. */
export const OTHER_TRAFFIC = "1000 rps, p99";

/**
 * What the declared path honestly knows about its own edges.
 *
 * `buildGraphIr` finds reference edges: a typed `AttrRef` or a `Ref` intrinsic
 * in one entity's props, pointing at another. On the declared path that is
 * exhaustive for references — every reference between these entities is here —
 * and it says nothing at all about containment. A subnet's membership of a VPC
 * is not a reference and produces no edge, which is exactly the gap
 * `PredictBehaviourOptions.edgeCoverage` was added for (#2365, finding 6): an
 * engine asked whether an estate survives one zone lost, over a graph carrying
 * no zone membership, answers confidently and wrongly.
 *
 * So `partial`, naming the two kinds whose containment is missing, rather than
 * `complete`. `complete` would be a true claim about references and a
 * misleading one about the graph, and `validateEdgeCoverage` refuses a
 * `partial` that names nothing so that this cannot be a shrug.
 */
export const DECLARED_EDGE_COVERAGE: BehaviourEdgeCoverage = {
  verdict: "partial",
  unresolvedKinds: ["AWS::EC2::VPC", "AWS::EC2::Subnet"],
};

/** Build the example project and assemble the options a caller would hand over. */
export async function exampleRequestOptions(
  traffic: string = GOLDEN_TRAFFIC,
): Promise<PredictBehaviourOptions> {
  const lexicons = await resolveProjectLexicons(EXAMPLE_ROOT);
  const plugins = (await loadPlugins(lexicons as string[])) as LexiconPlugin[];
  const result = await build(
    join(EXAMPLE_ROOT, "src"),
    plugins.map((p) => p.serializer),
  );
  if (result.errors.length > 0) {
    throw new Error(`the example did not build: ${result.errors.join("; ")}`);
  }

  const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [name, entity] of result.entities) {
    const declarable = entity as { entityType?: string; props?: Record<string, unknown> };
    if (!declarable.entityType) continue;
    entities.set(name, { entityType: declarable.entityType, props: declarable.props ?? {} });
  }

  return {
    environment: "dev",
    buildOutput: join(EXAMPLE_ROOT, "build"),
    entityNames: [...entities.keys()],
    entities,
    region: "us-east-1",
    traffic,
    edges: buildGraphIr(result.entities).edges,
    edgeCoverage: DECLARED_EDGE_COVERAGE,
  };
}
