/**
 * A spec a wave job renders at run time (`renderSpec`, #4982), checked
 * against the fold's schema (#5324).
 *
 * A product that has not moved to `.chant/pipeline.ts` keeps printing its
 * spec from its config. The job reads that output with the schema a folded
 * pipeline's stage has: an op-waves spec is checked as each stage's derived
 * spec is (`assertOpWavesSpec`, with a wave's `failureTolerance`), and a
 * folded pipeline document (`kind: "chant.pipeline/v1"`) is checked with
 * `pipelineSpecProblems` and runs the stage `CHANT_PIPELINE_STAGE` names,
 * or its first. Either way a spec the fold could not have produced fails
 * the job before anything is planned.
 */

import { assertOpWavesSpec, type OpWavesSpec } from "../op/op-waves";
import { asPipelineSpec, isPipelineSpecDocument } from "./spec";
import { stageWavesSpec } from "./stages";

/** The job variable naming the stage a rendered pipeline document runs. */
export const PIPELINE_STAGE_ENV = "CHANT_PIPELINE_STAGE";

/**
 * Check a rendered spec's text and hand back the op-waves spec's text the
 * job runs. A pipeline document becomes its stage's spec; an op-waves spec
 * is checked and passed on as printed. `parse` reads an op-waves spec's
 * text (`parseOpWavesSpec`). Throws on a spec the fold could not produce.
 */
export function checkRenderedWavesSpec(text: string, where: string, parse: (text: string, where: string) => OpWavesSpec, env: NodeJS.ProcessEnv = process.env): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    parse(text, where);
    return text;
  }
  if (isPipelineSpecDocument(doc)) {
    const spec = asPipelineSpec(doc, where);
    return `${JSON.stringify(stageWavesSpec(spec, env[PIPELINE_STAGE_ENV] || spec.stages[0]!.name), null, 2)}\n`;
  }
  const spec = parse(text, where);
  try {
    assertOpWavesSpec(spec);
  } catch (err) {
    throw new Error(`${where} does not check against the pipeline's schema: ${err instanceof Error ? err.message : String(err)}`);
  }
  return text;
}

/** A render (`OpWavesSpecRender`) whose every output goes through {@link checkRenderedWavesSpec}. */
export function checkedRender(render: (sha: string) => string | null, parse: (text: string, where: string) => OpWavesSpec, env: NodeJS.ProcessEnv = process.env): (sha: string) => string | null {
  return (sha) => {
    const text = render(sha);
    return text === null ? null : checkRenderedWavesSpec(text, `the spec rendered at ${sha.slice(0, 12)}`, parse, env);
  };
}
